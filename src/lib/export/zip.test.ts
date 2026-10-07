import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../test/factories";
import { toExportRows } from "./rows";
import { buildCandidatesZip, safeFileStem } from "./zip";

async function addCandidate(job: { id: string; companyId: string }, fileName: string, bytes: Buffer, name?: string) {
  const cv = await validateCvUpload(new File([new Uint8Array(bytes)], fileName));
  return createCandidateFromCv({
    job,
    source: name ? "public" : "upload",
    cv,
    applicant: name ? { name, email: `${crypto.randomUUID()}@example.com`, phone: null } : undefined,
  });
}

describe("buildCandidatesZip", () => {
  it("bundles the CSV, the XLSX and every original CV under a ranked, safe name", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const pdf = Buffer.from("%PDF-1.4\nJosé's real CV bytes\n");
    const txt = Buffer.from("Plain text CV\nwith two lines\n");
    const first = await addCandidate(job, "jose.pdf", pdf, "José Álvarez-Núñez");
    const second = await addCandidate(job, "../../weird name?.txt", txt);
    const list = [first, second];

    const buffer = await buildCandidatesZip(list, toExportRows(list), { baseName: "backend-candidates-2026-10-07" });
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();

    expect(names).toEqual([
      "backend-candidates-2026-10-07.csv",
      "backend-candidates-2026-10-07.xlsx",
      "cvs/001-Jose-Alvarez-Nunez.pdf",
      "cvs/002-weird-name-txt.txt",
    ]);
    for (const n of names.filter((n) => n.startsWith("cvs/"))) expect(n).toMatch(/^cvs\/\d{3}-[A-Za-z0-9-]{1,60}\.(pdf|docx|txt)$/);
    expect(await zip.file("cvs/001-Jose-Alvarez-Nunez.pdf")!.async("nodebuffer")).toEqual(pdf);
    expect(await zip.file("cvs/002-weird-name-txt.txt")!.async("nodebuffer")).toEqual(txt);

    const csv = await zip.file("backend-candidates-2026-10-07.csv")!.async("string");
    expect(csv).toContain("José Álvarez-Núñez");
    const xlsx = await zip.file("backend-candidates-2026-10-07.xlsx")!.async("nodebuffer");
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    expect(zip.file("missing-files.txt")).toBeNull();
  });

  it("skips CVs missing from disk and lists them in missing-files.txt instead of failing", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const kept = await addCandidate(job, "kept.pdf", Buffer.from("%PDF-1.4 kept"), "Kept Person");
    const lost = await addCandidate(job, "lost.pdf", Buffer.from("%PDF-1.4 lost"), "Lost Person");
    fs.rmSync(path.join(process.env.UPLOAD_DIR!, lost.cvFileKey));
    const list = [kept, lost];

    const zip = await JSZip.loadAsync(await buildCandidatesZip(list, toExportRows(list), { baseName: "export" }));
    expect(zip.file("cvs/001-Kept-Person.pdf")).not.toBeNull();
    expect(zip.file(/^cvs\/002-/)).toHaveLength(0);

    const missing = await zip.file("missing-files.txt")!.async("string");
    expect(missing).toContain("Lost Person");
    expect(missing).toContain("lost.pdf");
    expect(missing).not.toContain("Kept Person");
    // The spreadsheets still list everyone.
    expect(await zip.file("export.csv")!.async("string")).toContain("Lost Person");
  });
});

describe("safeFileStem", () => {
  it("keeps ASCII letters, digits and dashes, capped at 60", () => {
    expect(safeFileStem("Zoë O'Brien / 王")).toBe("Zoe-O-Brien");
    expect(safeFileStem("王小明")).toBe("candidate");
    expect(safeFileStem("a".repeat(80))).toHaveLength(60);
    expect(safeFileStem(`${"a".repeat(59)} b`)).toBe("a".repeat(59));
  });
});
