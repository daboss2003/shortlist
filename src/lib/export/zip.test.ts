import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate } from "@/db/schema";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import type { RankedCandidate } from "@/lib/data/candidates";
import { readCvFile } from "@/lib/storage";
import { makeCompany, makeJob } from "../../../test/factories";
import { toExportRows } from "./rows";
import { ZipTooLargeError, buildCandidatesZip, safeFileStem } from "./zip";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, readCvFile: vi.fn(actual.readCvFile) };
});

async function addCandidate(job: { id: string; companyId: string }, fileName: string, bytes: Buffer, name?: string) {
  const cv = await validateCvUpload(new File([new Uint8Array(bytes)], fileName));
  return createCandidateFromCv({
    job,
    source: name ? "public" : "upload",
    cv,
    applicant: name ? { name, email: `${crypto.randomUUID()}@example.com`, phone: null } : undefined,
  });
}

const ranked = (c: Candidate, rank: number | null): RankedCandidate => ({ ...c, rank });

async function build(list: RankedCandidate[], baseName = "export") {
  return buildCandidatesZip(list, toExportRows(list), { baseName });
}

const readAll = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());

beforeEach(() => {
  vi.mocked(readCvFile).mockClear();
});

describe("buildCandidatesZip", () => {
  it("bundles the CSV, the XLSX and every original CV, named by on-screen rank", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const pdf = Buffer.from("%PDF-1.4\nJosé's real CV bytes\n");
    const txt = Buffer.from("Plain text CV\nwith two lines\n");
    const first = ranked(await addCandidate(job, "jose.pdf", pdf, "José Álvarez-Núñez"), 7);
    const second = ranked(await addCandidate(job, "../../weird name?.txt", txt), null);

    const zip = await JSZip.loadAsync(await readAll(await build([first, second], "backend-candidates-2026-10-07")));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();

    const unranked = `cvs/unranked-${second.id.slice(0, 8)}-weird-name-txt.txt`;
    expect(names).toEqual([
      "backend-candidates-2026-10-07.csv",
      "backend-candidates-2026-10-07.xlsx",
      "cvs/007-Jose-Alvarez-Nunez.pdf",
      unranked,
    ]);
    expect(await zip.file("cvs/007-Jose-Alvarez-Nunez.pdf")!.async("nodebuffer")).toEqual(pdf);
    expect(await zip.file(unranked)!.async("nodebuffer")).toEqual(txt);

    const csv = await zip.file("backend-candidates-2026-10-07.csv")!.async("string");
    expect(csv).toContain("José Álvarez-Núñez");
    const xlsx = await zip.file("backend-candidates-2026-10-07.xlsx")!.async("nodebuffer");
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    expect(zip.file("missing-files.txt")).toBeNull();
  });

  it("skips CVs missing from disk and lists them in missing-files.txt instead of failing", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const kept = ranked(await addCandidate(job, "kept.pdf", Buffer.from("%PDF-1.4 kept"), "Kept Person"), 1);
    const lost = ranked(await addCandidate(job, "lost.pdf", Buffer.from("%PDF-1.4 lost"), "Lost Person"), 2);
    fs.rmSync(path.join(process.env.UPLOAD_DIR!, lost.cvFileKey));

    const zip = await JSZip.loadAsync(await readAll(await build([kept, lost])));
    expect(zip.file("cvs/001-Kept-Person.pdf")).not.toBeNull();
    expect(zip.file(/^cvs\/002-/)).toHaveLength(0);

    const missing = await zip.file("missing-files.txt")!.async("string");
    expect(missing).toContain("#2 — Lost Person (lost.pdf)");
    expect(missing).not.toContain("Kept Person");
    // The spreadsheets still list everyone.
    expect(await zip.file("export.csv")!.async("string")).toContain("Lost Person");
  });

  it("keeps entry names unique when two unranked ids share their short prefix", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const a = await addCandidate(job, "a.pdf", Buffer.from("%PDF-1.4 a"), "Same Name");
    const b = await addCandidate(job, "b.pdf", Buffer.from("%PDF-1.4 b"), "Same Name");
    const list = [
      { ...ranked(a, null), id: "abcdef12-0000-4000-8000-000000000001" },
      { ...ranked(b, null), id: "abcdef12-0000-4000-8000-000000000002" },
    ];

    const zip = await JSZip.loadAsync(await readAll(await build(list)));
    const cvs = zip.file(/^cvs\//).map((f) => f.name);
    expect(cvs).toHaveLength(2);
    expect(new Set(cvs).size).toBe(2);
    expect(await zip.file(cvs[1])!.async("string")).toBe("%PDF-1.4 b");
  });

  it("streams: CVs are read as the archive is consumed, not all before the first byte", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const list: RankedCandidate[] = [];
    for (let i = 0; i < 20; i++) {
      const bytes = Buffer.concat([Buffer.from(`%PDF-1.4 cv ${i}\n`), Buffer.alloc(100 * 1024, i)]);
      list.push(ranked(await addCandidate(job, `cv-${i}.pdf`, bytes, `Person ${i}`), i + 1));
    }

    const stream = await build(list);
    const reads = () => vi.mocked(readCvFile).mock.calls.length;
    expect(reads()).toBe(20); // the existence check, one at a time

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [(await reader.read()).value!];
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads() - 20).toBeLessThan(10);

    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
    expect(reads()).toBe(40);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(zip.file(/^cvs\//)).toHaveLength(20);
    expect((await zip.file("cvs/020-Person-19.pdf")!.async("nodebuffer")).subarray(0, 15).toString()).toBe("%PDF-1.4 cv 19\n");
  });

  it("refuses an export over the size cap before reading any CV", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const c = await addCandidate(job, "big.pdf", Buffer.from("%PDF-1.4 big"), "Big One");
    const list = [
      { ...ranked(c, 1), cvSize: 600 * 1024 * 1024 },
      { ...ranked(c, 2), id: crypto.randomUUID(), cvSize: 600 * 1024 * 1024 },
    ];

    await expect(build(list)).rejects.toThrow(ZipTooLargeError);
    await expect(build(list)).rejects.toThrow("Too many CVs for one ZIP — export a stage or a selection.");
    expect(readCvFile).not.toHaveBeenCalled();
  });

  it("fails the download rather than shipping an empty CV when a file vanishes mid-stream", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const list: RankedCandidate[] = [];
    for (let i = 0; i < 12; i++) {
      const bytes = Buffer.concat([Buffer.from(`%PDF-1.4 cv ${i}\n`), Buffer.alloc(100 * 1024, i)]);
      list.push(ranked(await addCandidate(job, `cv-${i}.pdf`, bytes, `Person ${i}`), i + 1));
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const stream = await build(list);
    fs.rmSync(path.join(process.env.UPLOAD_DIR!, list[11].cvFileKey));

    await expect(readAll(stream)).rejects.toThrow();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("disappeared mid-download"), expect.anything());
    errors.mockRestore();
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
