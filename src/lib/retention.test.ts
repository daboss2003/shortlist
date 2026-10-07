import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates, companies, jobs } from "@/db/schema";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import * as storage from "@/lib/storage";
import { makeCompany, makeJob } from "../../test/factories";
import { candidateDataDeletionDate, getCompanyRetentionDays, purgeExpiredCandidateData } from "./retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-01-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

async function addCandidate(job: { id: string; companyId: string }, createdAt = daysAgo(200)) {
  // Unique bytes per CV: identical files uploaded to one job are rejected as duplicates.
  const bytes = Buffer.from(`%PDF-1.4\n% ${crypto.randomUUID()}\n`);
  const cv = await validateCvUpload(new File([new Uint8Array(bytes)], "cv.pdf"));
  const c = await createCandidateFromCv({ job, source: "upload", cv });
  await db.update(candidates).set({ createdAt }).where(eq(candidates.id, c.id));
  return c;
}

async function setup({ retentionDays = 90 as number | null, closedDaysAgo = null as number | null } = {}) {
  const { company } = await makeCompany();
  await db.update(companies).set({ retentionDays }).where(eq(companies.id, company.id));
  const job = await makeJob(company.id, closedDaysAgo === null ? {} : { status: "closed", closedAt: daysAgo(closedDaysAgo) });
  return { company, job };
}

const exists = async (id: string) => (await db.select().from(candidates).where(eq(candidates.id, id))).length > 0;
const fileExists = (key: string) => fs.existsSync(path.join(process.env.UPLOAD_DIR!, key));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("purgeExpiredCandidateData", () => {
  it("deletes candidate rows and CV files once the job has been closed longer than the retention period", async () => {
    const { job } = await setup({ closedDaysAgo: 91 });
    const c = await addCandidate(job);

    expect(await purgeExpiredCandidateData(NOW)).toBeGreaterThanOrEqual(1);
    expect(await exists(c.id)).toBe(false);
    expect(fileExists(c.cvFileKey)).toBe(false);
    expect(await db.select().from(jobs).where(eq(jobs.id, job.id))).toHaveLength(1);
  });

  it("keeps candidates of open jobs, of jobs still inside the period, and of companies with retention off", async () => {
    const open = await addCandidate((await setup()).job);
    const recent = await addCandidate((await setup({ closedDaysAgo: 89 })).job);
    const off = await addCandidate((await setup({ retentionDays: null, closedDaysAgo: 1000 })).job);

    await purgeExpiredCandidateData(NOW);
    expect(await exists(open.id)).toBe(true);
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(off.id)).toBe(true);
    expect(fileExists(off.cvFileKey)).toBe(true);
  });

  it("gives CVs added after the job closed their own full period", async () => {
    const { job } = await setup({ closedDaysAgo: 100 });
    const lateFresh = await addCandidate(job, daysAgo(10));
    const lateExpired = await addCandidate(job, daysAgo(95));

    await purgeExpiredCandidateData(NOW);
    expect(await exists(lateFresh.id)).toBe(true);
    expect(await exists(lateExpired.id)).toBe(false);
  });

  it("deletes exactly at the end of the period, not a moment before", async () => {
    const { job } = await setup({ closedDaysAgo: 90 });
    const c = await addCandidate(job);

    await purgeExpiredCandidateData(new Date(NOW.getTime() - 1));
    expect(await exists(c.id)).toBe(true);
    await purgeExpiredCandidateData(NOW);
    expect(await exists(c.id)).toBe(false);
  });

  it("applies each company's own retention period", async () => {
    const short = await addCandidate((await setup({ retentionDays: 30, closedDaysAgo: 31 })).job);
    const long = await addCandidate((await setup({ retentionDays: 180, closedDaysAgo: 31 })).job);

    await purgeExpiredCandidateData(NOW);
    expect(await exists(short.id)).toBe(false);
    expect(await exists(long.id)).toBe(true);
  });

  it("deletes at most `limit` candidates per run, oldest first, and the rest on the next run", async () => {
    await purgeExpiredCandidateData(NOW);
    const { job } = await setup({ closedDaysAgo: 400 });
    const oldest = await addCandidate(job, daysAgo(300));
    const middle = await addCandidate(job, daysAgo(250));
    const newest = await addCandidate(job, daysAgo(200));

    expect(await purgeExpiredCandidateData(NOW, { limit: 2 })).toBe(2);
    expect([await exists(oldest.id), await exists(middle.id), await exists(newest.id)]).toEqual([false, false, true]);
    expect(await purgeExpiredCandidateData(NOW, { limit: 2 })).toBe(1);
    expect(await exists(newest.id)).toBe(false);
  });

  it("keeps the row of a CV whose file couldn't be deleted, so the next run retries it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { job } = await setup({ closedDaysAgo: 91 });
    const stuck = await addCandidate(job);
    const fine = await addCandidate(job);
    const realDelete = storage.deleteCvFile;
    vi.spyOn(storage, "deleteCvFile").mockImplementation(async (key) => {
      if (key === stuck.cvFileKey) throw new Error("storage unavailable");
      return realDelete(key);
    });

    await purgeExpiredCandidateData(NOW);
    expect(await exists(stuck.id)).toBe(true);
    expect(await exists(fine.id)).toBe(false);

    vi.mocked(storage.deleteCvFile).mockRestore();
    await purgeExpiredCandidateData(NOW);
    expect(await exists(stuck.id)).toBe(false);
    expect(fileExists(stuck.cvFileKey)).toBe(false);
  });
});

describe("getCompanyRetentionDays", () => {
  it("is the company's setting, or null when off or the company is unknown", async () => {
    const { company } = await setup({ retentionDays: 30 });
    expect(await getCompanyRetentionDays(company.id)).toBe(30);
    await db.update(companies).set({ retentionDays: null }).where(eq(companies.id, company.id));
    expect(await getCompanyRetentionDays(company.id)).toBeNull();
    expect(await getCompanyRetentionDays("no-such-company")).toBeNull();
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
