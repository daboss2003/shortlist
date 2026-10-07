import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates, companies, jobs } from "@/db/schema";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../test/factories";
import { candidateDataDeletionDate, purgeExpiredCandidateData } from "./retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-01-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

async function addCandidate(job: { id: string; companyId: string }, createdAt = daysAgo(200)) {
  // Unique bytes per CV: identical files uploaded to one job are rejected as duplicates.
  const bytes = Buffer.from(`%PDF-1.4\n% ${crypto.randomUUID()}\n`);
  const cv = await validateCvUpload(new File([new Uint8Array(bytes)], "cv.pdf"));
  const c = await createCandidateFromCv({ job, source: "upload", cv });
  db.update(candidates).set({ createdAt }).where(eq(candidates.id, c.id)).run();
  return c;
}

function setup({ retentionDays = 90 as number | null, closedDaysAgo = null as number | null } = {}) {
  const { company } = makeCompany();
  db.update(companies).set({ retentionDays }).where(eq(companies.id, company.id)).run();
  const job = makeJob(company.id, closedDaysAgo === null ? {} : { status: "closed", closedAt: daysAgo(closedDaysAgo) });
  return { company, job };
}

const exists = (id: string) => !!db.select().from(candidates).where(eq(candidates.id, id)).get();
const fileExists = (key: string) => fs.existsSync(path.join(process.env.UPLOAD_DIR!, key));

describe("purgeExpiredCandidateData", () => {
  it("deletes candidate rows and CV files once the job has been closed longer than the retention period", async () => {
    const { job } = setup({ closedDaysAgo: 91 });
    const c = await addCandidate(job);

    expect(await purgeExpiredCandidateData(NOW)).toBeGreaterThanOrEqual(1);
    expect(exists(c.id)).toBe(false);
    expect(fileExists(c.cvFileKey)).toBe(false);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()).toBeTruthy();
  });

  it("keeps candidates of open jobs, of jobs still inside the period, and of companies with retention off", async () => {
    const open = await addCandidate(setup().job);
    const recent = await addCandidate(setup({ closedDaysAgo: 89 }).job);
    const off = await addCandidate(setup({ retentionDays: null, closedDaysAgo: 1000 }).job);

    await purgeExpiredCandidateData(NOW);
    expect(exists(open.id)).toBe(true);
    expect(exists(recent.id)).toBe(true);
    expect(exists(off.id)).toBe(true);
    expect(fileExists(off.cvFileKey)).toBe(true);
  });

  it("gives CVs added after the job closed their own full period", async () => {
    const { job } = setup({ closedDaysAgo: 100 });
    const lateFresh = await addCandidate(job, daysAgo(10));
    const lateExpired = await addCandidate(job, daysAgo(95));

    await purgeExpiredCandidateData(NOW);
    expect(exists(lateFresh.id)).toBe(true);
    expect(exists(lateExpired.id)).toBe(false);
  });

  it("applies each company's own retention period", async () => {
    const short = await addCandidate(setup({ retentionDays: 30, closedDaysAgo: 31 }).job);
    const long = await addCandidate(setup({ retentionDays: 180, closedDaysAgo: 31 }).job);

    await purgeExpiredCandidateData(NOW);
    expect(exists(short.id)).toBe(false);
    expect(exists(long.id)).toBe(true);
  });
});

describe("candidateDataDeletionDate", () => {
  it("is closedAt + retention for a closed job, else null", () => {
    const closedAt = new Date("2027-01-01T00:00:00Z");
    expect(candidateDataDeletionDate({ status: "closed", closedAt }, 30)).toEqual(new Date("2027-01-31T00:00:00Z"));
    expect(candidateDataDeletionDate({ status: "open", closedAt: null }, 30)).toBeNull();
    expect(candidateDataDeletionDate({ status: "closed", closedAt }, null)).toBeNull();
  });
});
