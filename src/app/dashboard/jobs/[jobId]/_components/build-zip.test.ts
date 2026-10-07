import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { ZipManifestEntry } from "@/app/api/jobs/[jobId]/export/route";
import {
  MAX_ZIP_CVS,
  MAX_ZIP_CV_BYTES,
  buildCandidatesZip,
  cvEntryName,
  missingFilesText,
  zipFileName,
  zipTooLarge,
  type FetchedCv,
} from "./build-zip";

function entry(overrides: Partial<ZipManifestEntry> = {}): ZipManifestEntry {
  return {
    id: crypto.randomUUID(),
    rank: 1,
    name: "Jane Doe",
    cvFileName: "jane.pdf",
    cvExt: "pdf",
    cvSize: 100,
    ...overrides,
  };
}

const blob = (content: BlobPart) => new Blob([content]);
const baseName = "backend-candidates-2026-10-07";

async function build(cvs: FetchedCv[]) {
  const zipped = await buildCandidatesZip({
    baseName,
    csv: blob("﻿Rank,Name\r\n1,José Álvarez-Núñez\r\n"),
    xlsx: blob(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
    cvs,
  });
  expect(zipped.type).toBe("application/zip");
  return JSZip.loadAsync(await zipped.arrayBuffer());
}

const fileNames = (zip: JSZip) =>
  Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir)
    .sort();

describe("cvEntryName", () => {
  it("names a ranked CV by its zero-padded on-screen rank and a folded, ASCII-only name", () => {
    const used = new Set<string>();
    expect(cvEntryName(entry({ rank: 7, name: "José Álvarez-Núñez" }), used)).toBe("cvs/007-Jose-Alvarez-Nunez.pdf");
    expect(cvEntryName(entry({ rank: 1234, name: "王小明", cvExt: "docx" }), used)).toBe("cvs/1234-candidate.docx");
  });

  it("names an unscored CV unranked-{first 8 of id}, with the stored type as extension", () => {
    const e = entry({ id: "1a2b3c4d-0000-4000-8000-000000000000", rank: null, name: "../../weird name?.txt", cvExt: "txt" });
    expect(cvEntryName(e, new Set())).toBe("cvs/unranked-1a2b3c4d-weird-name-txt.txt");
  });

  it("falls back to the full id when two unranked ids share their short prefix", () => {
    const used = new Set<string>();
    const a = entry({ id: "abcdef12-0000-4000-8000-000000000001", rank: null, name: "Same Name" });
    const b = entry({ id: "abcdef12-0000-4000-8000-000000000002", rank: null, name: "Same Name" });
    expect(cvEntryName(a, used)).toBe("cvs/unranked-abcdef12-Same-Name.pdf");
    expect(cvEntryName(b, used)).toBe("cvs/unranked-abcdef12-abcdef12-0000-4000-8000-000000000002-Same-Name.pdf");
  });
});

describe("missingFilesText", () => {
  it("lists each missing CV by rank, name and original file name, with CRLF line endings", () => {
    const text = missingFilesText([
      entry({ rank: 2, name: "Lost Person", cvFileName: "lost.pdf" }),
      entry({ rank: null, name: "Pending One", cvFileName: "p.docx" }),
    ]);
    expect(text).toBe(
      "These candidates' CV files could not be found or downloaded, so they are not in this ZIP:\r\n\r\n" +
        "#2 — Lost Person (lost.pdf)\r\nUnranked — Pending One (p.docx)\r\n",
    );
    expect(missingFilesText([])).toBeNull();
  });
});

describe("zipTooLarge", () => {
  it("refuses more than 5000 CVs or more than 1 GiB of CVs", () => {
    expect(zipTooLarge([])).toBe(false);
    expect(zipTooLarge(Array.from({ length: MAX_ZIP_CVS }, () => ({ cvSize: 1 })))).toBe(false);
    expect(zipTooLarge(Array.from({ length: MAX_ZIP_CVS + 1 }, () => ({ cvSize: 1 })))).toBe(true);
    expect(zipTooLarge([{ cvSize: MAX_ZIP_CV_BYTES }])).toBe(false);
    expect(zipTooLarge([{ cvSize: MAX_ZIP_CV_BYTES }, { cvSize: 1 }])).toBe(true);
  });
});

describe("buildCandidatesZip", () => {
  it("bundles the CSV, the XLSX and every CV with its exact bytes, named by rank", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\nJosé's real CV bytes\n");
    const txt = "Plain text CV\nwith two lines\n";
    const first = entry({ rank: 7, name: "José Álvarez-Núñez" });
    const second = entry({ id: "0f0f0f0f-0000-4000-8000-000000000000", rank: null, name: "cv.txt", cvExt: "txt" });

    const zip = await build([
      { entry: first, file: blob(pdf) },
      { entry: second, file: blob(txt) },
    ]);

    expect(fileNames(zip)).toEqual([
      `${baseName}.csv`,
      `${baseName}.xlsx`,
      "cvs/007-Jose-Alvarez-Nunez.pdf",
      "cvs/unranked-0f0f0f0f-cv-txt.txt",
    ]);
    expect(await zip.file("cvs/007-Jose-Alvarez-Nunez.pdf")!.async("uint8array")).toEqual(pdf);
    expect(await zip.file("cvs/unranked-0f0f0f0f-cv-txt.txt")!.async("string")).toBe(txt);
    expect(await zip.file(`${baseName}.csv`)!.async("string")).toBe("﻿Rank,Name\r\n1,José Álvarez-Núñez\r\n");
    expect(await zip.file(`${baseName}.xlsx`)!.async("uint8array")).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    expect(zip.file("missing-files.txt")).toBeNull();
  });

  it("leaves out CVs that couldn't be fetched and lists them in missing-files.txt", async () => {
    const kept = entry({ rank: 1, name: "Kept Person" });
    const lost = entry({ rank: 2, name: "Lost Person", cvFileName: "lost.pdf" });

    const zip = await build([
      { entry: kept, file: blob("%PDF-1.4 kept") },
      { entry: lost, file: null },
    ]);

    expect(fileNames(zip)).toEqual([`${baseName}.csv`, `${baseName}.xlsx`, "cvs/001-Kept-Person.pdf", "missing-files.txt"]);
    const missing = await zip.file("missing-files.txt")!.async("string");
    expect(missing).toContain("#2 — Lost Person (lost.pdf)");
    expect(missing).not.toContain("Kept Person");
  });

  it("still builds a ZIP of just the spreadsheets and the list when no CV could be fetched", async () => {
    const zip = await build([{ entry: entry({ rank: 1 }), file: null }]);
    expect(fileNames(zip)).toEqual([`${baseName}.csv`, `${baseName}.xlsx`, "missing-files.txt"]);
  });
});

describe("zipFileName", () => {
  it("names the ZIP after the export's base name", () => {
    expect(zipFileName(baseName)).toBe(`${baseName}.zip`);
  });
});
