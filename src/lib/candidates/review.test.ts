import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates, type Candidate } from "@/db/schema";
import * as storage from "@/lib/storage";
import { makeCompany, makeJob } from "../../../test/factories";
import { createCandidateFromCv, validateCvUpload } from "./intake";
import {
  CandidateDeleteIncompleteError,
  candidateDisplayName,
  deleteCandidate,
  deleteCandidates,
  deleteCvFilesFirst,
  markForRescore,
  setCandidatesStage,
} from "./review";

// Unique bytes per file: identical employer uploads to one job are rejected as duplicates.
const pdfFile = (name = "cv.pdf") =>
  new File([new Uint8Array(Buffer.from(`%PDF-1.4\n% test cv ${crypto.randomUUID()}\n`))], name, {
    type: "application/pdf",
  });

async function makeCandidate(job: { id: string; companyId: string }, name?: string) {
  const cv = await validateCvUpload(pdfFile(name));
  return createCandidateFromCv({ job, source: "upload", cv });
}

const getRow = async (id: string) => (await db.select().from(candidates).where(eq(candidates.id, id)))[0];
const setRow = async (id: string, values: Partial<Candidate>) => {
  await db.update(candidates).set(values).where(eq(candidates.id, id));
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes deleteCvFile fail for `failing` keys (storage down for those files) and delete the rest for real. */
function failDeletesFor(...failing: string[]) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realDelete = storage.deleteCvFile;
  return vi.spyOn(storage, "deleteCvFile").mockImplementation(async (key) => {
    if (failing.includes(key)) throw new Error("Blobs unavailable");
    return realDelete(key);
  });
}

async function twoTenants() {
  const a = await makeCompany();
  const b = await makeCompany();
  const jobA = await makeJob(a.company.id);
  const jobB = await makeJob(b.company.id);
  const [a1, a2] = [await makeCandidate(jobA), await makeCandidate(jobA)];
  const b1 = await makeCandidate(jobB);
  return { a, b, jobA, jobB, a1, a2, b1 };
}

describe("setCandidatesStage", () => {
  it("updates only the given candidates of the job", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    expect(await setCandidatesStage(a.company.id, jobA.id, [a1.id], "shortlisted")).toBe(1);
    expect((await getRow(a1.id))?.stage).toBe("shortlisted");
    expect((await getRow(a2.id))?.stage).toBe("new");
  });

  it("silently ignores another company's candidates and jobs", async () => {
    const { a, b, jobA, jobB, a1, b1 } = await twoTenants();
    expect(await setCandidatesStage(a.company.id, jobA.id, [a1.id, b1.id], "rejected")).toBe(1);
    expect((await getRow(b1.id))?.stage).toBe("new");
    // Right company, wrong job: nothing changes.
    expect(await setCandidatesStage(b.company.id, jobA.id, [a1.id], "shortlisted")).toBe(0);
    expect(await setCandidatesStage(a.company.id, jobB.id, [b1.id], "shortlisted")).toBe(0);
    expect((await getRow(a1.id))?.stage).toBe("rejected");
    expect((await getRow(b1.id))?.stage).toBe("new");
  });

  it("returns 0 for an empty id list", async () => {
    const { a, jobA } = await twoTenants();
    expect(await setCandidatesStage(a.company.id, jobA.id, [], "shortlisted")).toBe(0);
  });
});

describe("markForRescore", () => {
  it("re-queues ready and failed rows, keeps cvText and existing results, and clears the error", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    await setRow(a1.id, { status: "ready", score: 81, cvText: "Jane Doe, engineer", aiProvider: "gemini" });
    await setRow(a2.id, { status: "failed", error: "Provider timeout" });

    const ids = await markForRescore(a.company.id, jobA.id, [a1.id, a2.id]);

    expect(ids.sort()).toEqual([a1.id, a2.id].sort());
    expect(await getRow(a1.id)).toMatchObject({
      status: "pending",
      error: null,
      score: 81,
      cvText: "Jane Doe, engineer",
      aiProvider: "gemini",
    });
    expect(await getRow(a2.id)).toMatchObject({ status: "pending", error: null });
  });

  it("includes rows that are currently processing, so nothing is silently skipped", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    await setRow(a1.id, { status: "processing", cvText: "Mid-analysis text" });
    await setRow(a2.id, { status: "ready" });

    expect((await markForRescore(a.company.id, jobA.id, "all")).sort()).toEqual([a1.id, a2.id].sort());
    expect(await getRow(a1.id)).toMatchObject({ status: "pending", error: null, cvText: "Mid-analysis text" });
    expect(await markForRescore(a.company.id, jobA.id, [a1.id])).toEqual([a1.id]);
  });

  it("resets the attempt counter so boot recovery gives the re-score a full set of tries", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    await setRow(a1.id, { status: "failed", error: "Crashed", attempts: 3 });
    await setRow(a2.id, { status: "processing", attempts: 2 });

    await markForRescore(a.company.id, jobA.id, [a1.id, a2.id]);

    expect(await getRow(a1.id)).toMatchObject({ status: "pending", error: null, attempts: 0 });
    expect(await getRow(a2.id)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("'all' covers every candidate of that job only", async () => {
    const { a, jobA, a1, a2, b1 } = await twoTenants();
    const otherJob = await makeJob(a.company.id);
    const other = await makeCandidate(otherJob);
    for (const id of [a1.id, a2.id, b1.id, other.id]) await setRow(id, { status: "ready" });

    expect((await markForRescore(a.company.id, jobA.id, "all")).sort()).toEqual([a1.id, a2.id].sort());
    expect((await getRow(other.id))?.status).toBe("ready");
    expect((await getRow(b1.id))?.status).toBe("ready");
  });

  it("silently ignores another company's candidates", async () => {
    const { a, b, jobA, jobB, a1, b1 } = await twoTenants();
    await setRow(b1.id, { status: "failed", error: "x", attempts: 2 });

    expect(await markForRescore(a.company.id, jobA.id, [a1.id, b1.id])).toEqual([a1.id]);
    expect(await getRow(b1.id)).toMatchObject({ status: "failed", error: "x", attempts: 2 });
    expect(await markForRescore(a.company.id, jobB.id, "all")).toEqual([]);
    expect(await markForRescore(b.company.id, jobA.id, "all")).toEqual([]);
  });

  it("returns [] for an empty id list", async () => {
    const { a, jobA } = await twoTenants();
    expect(await markForRescore(a.company.id, jobA.id, [])).toEqual([]);
  });
});

describe("deleteCandidate", () => {
  it("deletes the row and removes the CV file from UPLOAD_DIR", async () => {
    const { a, a1, a2 } = await twoTenants();
    const file = path.join(process.env.UPLOAD_DIR!, a1.cvFileKey);
    expect(fs.existsSync(file)).toBe(true);

    expect(await deleteCandidate(a.company.id, a1.id)).toBe(true);

    expect(await getRow(a1.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(await getRow(a2.id)).toBeDefined();
  });

  it("refuses another company's candidate and leaves its file alone", async () => {
    const { a, b1 } = await twoTenants();
    const file = path.join(process.env.UPLOAD_DIR!, b1.cvFileKey);

    expect(await deleteCandidate(a.company.id, b1.id)).toBe(false);

    expect(await getRow(b1.id)).toBeDefined();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("returns false for a missing id", async () => {
    const { a } = await twoTenants();
    expect(await deleteCandidate(a.company.id, crypto.randomUUID())).toBe(false);
  });

  it("keeps the candidate when its file can't be deleted, so the file is never orphaned", async () => {
    const { a, a1 } = await twoTenants();
    failDeletesFor(a1.cvFileKey);

    const attempt = deleteCandidate(a.company.id, a1.id);
    await expect(attempt).rejects.toThrow(CandidateDeleteIncompleteError);
    await expect(attempt).rejects.toThrow("Couldn't delete the CV file. Try again.");

    expect(await getRow(a1.id)).toBeDefined();
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR!, a1.cvFileKey))).toBe(true);
  });

  it("deletes the row when the file was already missing", async () => {
    const { a, a1 } = await twoTenants();
    await storage.deleteCvFile(a1.cvFileKey);
    expect(await deleteCandidate(a.company.id, a1.id)).toBe(true);
    expect(await getRow(a1.id)).toBeUndefined();
  });

  it("never touches another company's file", async () => {
    const { a, b1 } = await twoTenants();
    const deleteSpy = vi.spyOn(storage, "deleteCvFile");
    expect(await deleteCandidate(a.company.id, b1.id)).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("deleteCandidates", () => {
  const cvPath = (key: string) => path.join(process.env.UPLOAD_DIR!, key);

  it("deletes the given candidates of the job and removes their CV files", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    const a3 = await makeCandidate(jobA);

    expect(await deleteCandidates(a.company.id, jobA.id, [a1.id, a3.id])).toBe(2);

    expect(await getRow(a1.id)).toBeUndefined();
    expect(await getRow(a3.id)).toBeUndefined();
    expect(fs.existsSync(cvPath(a1.cvFileKey))).toBe(false);
    expect(fs.existsSync(cvPath(a3.cvFileKey))).toBe(false);
    expect(await getRow(a2.id)).toBeDefined();
    expect(fs.existsSync(cvPath(a2.cvFileKey))).toBe(true);
  });

  it("deletes rows that are mid-analysis too", async () => {
    const { a, jobA, a1 } = await twoTenants();
    await setRow(a1.id, { status: "processing" });
    expect(await deleteCandidates(a.company.id, jobA.id, [a1.id])).toBe(1);
    expect(await getRow(a1.id)).toBeUndefined();
  });

  it("leaves another company's candidates and their files alone", async () => {
    const { a, b, jobA, jobB, a1, b1 } = await twoTenants();

    expect(await deleteCandidates(a.company.id, jobA.id, [a1.id, b1.id])).toBe(1);
    expect(await getRow(b1.id)).toBeDefined();
    expect(fs.existsSync(cvPath(b1.cvFileKey))).toBe(true);

    // Their own job id with our company, and our job id with their company: nothing matches.
    expect(await deleteCandidates(a.company.id, jobB.id, [b1.id])).toBe(0);
    expect(await deleteCandidates(b.company.id, jobA.id, [b1.id])).toBe(0);
    expect(await getRow(b1.id)).toBeDefined();
    expect(fs.existsSync(cvPath(b1.cvFileKey))).toBe(true);
  });

  it("only touches the given job, even within the same company", async () => {
    const { a, jobA, a1 } = await twoTenants();
    const otherJob = await makeJob(a.company.id);
    const other = await makeCandidate(otherJob);

    expect(await deleteCandidates(a.company.id, jobA.id, [a1.id, other.id])).toBe(1);
    expect(await getRow(other.id)).toBeDefined();
    expect(fs.existsSync(cvPath(other.cvFileKey))).toBe(true);
  });

  it("returns 0 for an empty list or unknown ids", async () => {
    const { a, jobA } = await twoTenants();
    expect(await deleteCandidates(a.company.id, jobA.id, [])).toBe(0);
    expect(await deleteCandidates(a.company.id, jobA.id, [crypto.randomUUID()])).toBe(0);
  });

  it("deletes files first: a file that fails keeps exactly its candidate, and the others are deleted", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    const a3 = await makeCandidate(jobA);
    failDeletesFor(a2.cvFileKey);

    const attempt = deleteCandidates(a.company.id, jobA.id, [a1.id, a2.id, a3.id]);
    await expect(attempt).rejects.toThrow(CandidateDeleteIncompleteError);
    await expect(attempt).rejects.toMatchObject({ deleted: 2, total: 3, message: "Deleted 2 of 3; try again for the rest." });

    expect(await getRow(a1.id)).toBeUndefined();
    expect(await getRow(a3.id)).toBeUndefined();
    expect(fs.existsSync(cvPath(a1.cvFileKey))).toBe(false);
    expect(fs.existsSync(cvPath(a3.cvFileKey))).toBe(false);
    // The kept candidate still points at its file, so nothing is orphaned and a retry can finish.
    expect(await getRow(a2.id)).toBeDefined();
    expect(fs.existsSync(cvPath(a2.cvFileKey))).toBe(true);

    vi.mocked(storage.deleteCvFile).mockRestore();
    expect(await deleteCandidates(a.company.id, jobA.id, [a1.id, a2.id, a3.id])).toBe(1);
    expect(await getRow(a2.id)).toBeUndefined();
    expect(fs.existsSync(cvPath(a2.cvFileKey))).toBe(false);
  });

  it("deletes nothing and says so when every file fails", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    failDeletesFor(a1.cvFileKey, a2.cvFileKey);
    await expect(deleteCandidates(a.company.id, jobA.id, [a1.id, a2.id])).rejects.toMatchObject({
      deleted: 0,
      total: 2,
      message: "Couldn't delete the CV files. Try again.",
    });
    expect(await getRow(a1.id)).toBeDefined();
    expect(await getRow(a2.id)).toBeDefined();
  });

  it("deletes the rows whose files were already missing", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    await storage.deleteCvFile(a1.cvFileKey);
    expect(await deleteCandidates(a.company.id, jobA.id, [a1.id, a2.id])).toBe(2);
    expect(await getRow(a1.id)).toBeUndefined();
  });

  it("deletes at most 8 files at a time", async () => {
    const { a, jobA } = await twoTenants();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await makeCandidate(jobA)).id);
    const realDelete = storage.deleteCvFile;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(storage, "deleteCvFile").mockImplementation(async (key) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await realDelete(key);
      } finally {
        inFlight--;
      }
    });

    expect(await deleteCandidates(a.company.id, jobA.id, ids)).toBe(20);
    expect(maxInFlight).toBe(8);
  });

  it("never touches files of another company's or another job's candidates", async () => {
    const { a, jobA, a1, b1 } = await twoTenants();
    const other = await makeCandidate(await makeJob(a.company.id));
    const deleteSpy = vi.spyOn(storage, "deleteCvFile");

    // Another company naming our job and our candidate gets nothing.
    expect(await deleteCandidates(b1.companyId, jobA.id, [a1.id])).toBe(0);
    expect(await deleteCandidate(b1.companyId, a1.id)).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await getRow(a1.id)).toBeDefined();

    expect(await deleteCandidates(a.company.id, jobA.id, [a1.id, b1.id, other.id])).toBe(1);
    expect(deleteSpy.mock.calls).toEqual([[a1.cvFileKey]]);
  });
});

describe("deleteCvFilesFirst", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, cvFileKey: `${crypto.randomUUID()}.pdf` }));

  it("starts no delete after the deadline and reports the rows it didn't reach as failed", async () => {
    const all = rows(10);
    const deadline = Date.now() + 60_000;
    let started = 0;
    // The clock passes the deadline once 4 deletes have started.
    vi.spyOn(Date, "now").mockImplementation(() => (started >= 4 ? deadline : deadline - 1));
    vi.spyOn(storage, "deleteCvFile").mockImplementation(async () => {
      started++;
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    const { deleted, failed } = await deleteCvFilesFirst(all, { concurrency: 2, deadline });

    expect(started).toBe(4);
    expect(deleted).toEqual(all.slice(0, 4));
    expect(failed).toEqual(all.slice(4));
  });

  it("returns both lists in input order whatever order the deletes finish in", async () => {
    const all = rows(6);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(storage, "deleteCvFile").mockImplementation(async (key) => {
      const i = all.findIndex((r) => r.cvFileKey === key);
      await new Promise((resolve) => setTimeout(resolve, (6 - i) * 2));
      if (i % 2 === 1) throw new Error("nope");
    });

    const { deleted, failed } = await deleteCvFilesFirst(all);
    expect(deleted.map((r) => r.id)).toEqual([0, 2, 4]);
    expect(failed.map((r) => r.id)).toEqual([1, 3, 5]);
  });

  it("does nothing for no rows", async () => {
    expect(await deleteCvFilesFirst([])).toEqual({ deleted: [], failed: [] });
  });
});

describe("candidateDisplayName", () => {
  const profile = { fullName: "Jane From CV" } as Candidate["profile"];
  it("prefers the typed name, then the CV's name, then the file name", () => {
    expect(candidateDisplayName({ name: "Jane", profile, cvFileName: "cv.pdf" })).toBe("Jane");
    expect(candidateDisplayName({ name: null, profile, cvFileName: "cv.pdf" })).toBe("Jane From CV");
    expect(candidateDisplayName({ name: "  ", profile: null, cvFileName: "cv.pdf" })).toBe("cv.pdf");
  });
});
