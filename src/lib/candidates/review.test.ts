import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { candidates, type Candidate } from "@/db/schema";
import { makeCompany, makeJob } from "../../../test/factories";
import { createCandidateFromCv, validateCvUpload } from "./intake";
import { candidateDisplayName, deleteCandidate, markForRescore, setCandidatesStage } from "./review";

const pdfFile = (name = "cv.pdf") =>
  new File([new Uint8Array(Buffer.from("%PDF-1.4\n% test cv\n"))], name, { type: "application/pdf" });

async function makeCandidate(job: { id: string; companyId: string }, name?: string) {
  const cv = await validateCvUpload(pdfFile(name));
  return createCandidateFromCv({ job, source: "upload", cv });
}

const getRow = (id: string) => db.select().from(candidates).where(eq(candidates.id, id)).get();
const setRow = (id: string, values: Partial<Candidate>) =>
  db.update(candidates).set(values).where(eq(candidates.id, id)).run();

async function twoTenants() {
  const a = makeCompany();
  const b = makeCompany();
  const jobA = makeJob(a.company.id);
  const jobB = makeJob(b.company.id);
  const [a1, a2] = [await makeCandidate(jobA), await makeCandidate(jobA)];
  const b1 = await makeCandidate(jobB);
  return { a, b, jobA, jobB, a1, a2, b1 };
}

describe("setCandidatesStage", () => {
  it("updates only the given candidates of the job", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    expect(setCandidatesStage(a.company.id, jobA.id, [a1.id], "shortlisted")).toBe(1);
    expect(getRow(a1.id)?.stage).toBe("shortlisted");
    expect(getRow(a2.id)?.stage).toBe("new");
  });

  it("silently ignores another company's candidates and jobs", async () => {
    const { a, b, jobA, jobB, a1, b1 } = await twoTenants();
    expect(setCandidatesStage(a.company.id, jobA.id, [a1.id, b1.id], "rejected")).toBe(1);
    expect(getRow(b1.id)?.stage).toBe("new");
    // Right company, wrong job: nothing changes.
    expect(setCandidatesStage(b.company.id, jobA.id, [a1.id], "shortlisted")).toBe(0);
    expect(setCandidatesStage(a.company.id, jobB.id, [b1.id], "shortlisted")).toBe(0);
    expect(getRow(a1.id)?.stage).toBe("rejected");
    expect(getRow(b1.id)?.stage).toBe("new");
  });

  it("returns 0 for an empty id list", async () => {
    const { a, jobA } = await twoTenants();
    expect(setCandidatesStage(a.company.id, jobA.id, [], "shortlisted")).toBe(0);
  });
});

describe("markForRescore", () => {
  it("re-queues ready and failed rows, keeps cvText and existing results, and clears the error", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    setRow(a1.id, { status: "ready", score: 81, cvText: "Jane Doe, engineer", aiProvider: "gemini" });
    setRow(a2.id, { status: "failed", error: "Provider timeout" });

    const ids = markForRescore(a.company.id, jobA.id, [a1.id, a2.id]);

    expect(ids.sort()).toEqual([a1.id, a2.id].sort());
    expect(getRow(a1.id)).toMatchObject({ status: "pending", error: null, score: 81, cvText: "Jane Doe, engineer", aiProvider: "gemini" });
    expect(getRow(a2.id)).toMatchObject({ status: "pending", error: null });
  });

  it("skips rows that are currently processing", async () => {
    const { a, jobA, a1, a2 } = await twoTenants();
    setRow(a1.id, { status: "processing" });
    setRow(a2.id, { status: "ready" });

    expect(markForRescore(a.company.id, jobA.id, "all")).toEqual([a2.id]);
    expect(getRow(a1.id)?.status).toBe("processing");
  });

  it("'all' covers every candidate of that job only", async () => {
    const { a, jobA, a1, a2, b1 } = await twoTenants();
    const otherJob = makeJob(a.company.id);
    const other = await makeCandidate(otherJob);
    for (const id of [a1.id, a2.id, b1.id, other.id]) setRow(id, { status: "ready" });

    expect(markForRescore(a.company.id, jobA.id, "all").sort()).toEqual([a1.id, a2.id].sort());
    expect(getRow(other.id)?.status).toBe("ready");
    expect(getRow(b1.id)?.status).toBe("ready");
  });

  it("silently ignores another company's candidates", async () => {
    const { a, b, jobA, jobB, a1, b1 } = await twoTenants();
    setRow(b1.id, { status: "failed", error: "x" });

    expect(markForRescore(a.company.id, jobA.id, [a1.id, b1.id])).toEqual([a1.id]);
    expect(getRow(b1.id)).toMatchObject({ status: "failed", error: "x" });
    expect(markForRescore(a.company.id, jobB.id, "all")).toEqual([]);
    expect(markForRescore(b.company.id, jobA.id, "all")).toEqual([]);
  });

  it("returns [] for an empty id list", async () => {
    const { a, jobA } = await twoTenants();
    expect(markForRescore(a.company.id, jobA.id, [])).toEqual([]);
  });
});

describe("deleteCandidate", () => {
  it("deletes the row and removes the CV file from UPLOAD_DIR", async () => {
    const { a, a1, a2 } = await twoTenants();
    const file = path.join(process.env.UPLOAD_DIR!, a1.cvFileKey);
    expect(fs.existsSync(file)).toBe(true);

    expect(await deleteCandidate(a.company.id, a1.id)).toBe(true);

    expect(getRow(a1.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(getRow(a2.id)).toBeDefined();
  });

  it("refuses another company's candidate and leaves its file alone", async () => {
    const { a, b1 } = await twoTenants();
    const file = path.join(process.env.UPLOAD_DIR!, b1.cvFileKey);

    expect(await deleteCandidate(a.company.id, b1.id)).toBe(false);

    expect(getRow(b1.id)).toBeDefined();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("returns false for a missing id", async () => {
    const { a } = await twoTenants();
    expect(await deleteCandidate(a.company.id, crypto.randomUUID())).toBe(false);
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
