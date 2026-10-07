import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { candidates, companies, jobs, type JobStatus } from "@/db/schema";
import { deleteCvFile } from "@/lib/storage";

// Candidate data retention: once a job has been closed for the company's retention period, every
// candidate on it (row = extracted text, profile, evaluation; plus the CV file) is permanently deleted.
// The job itself is kept — it holds no applicant data.

/** Choices offered in Settings. `null` (Off) keeps data until deleted manually. */
export const RETENTION_DAY_OPTIONS = [30, 90, 180] as const;
export type RetentionDays = (typeof RETENTION_DAY_OPTIONS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * When this job's candidate data will be deleted, or null if the job is open or retention is off.
 * CVs uploaded after the job closed get their own full period (see purgeExpiredCandidateData).
 */
export function candidateDataDeletionDate(
  job: { status: JobStatus; closedAt: Date | null },
  retentionDays: number | null,
): Date | null {
  if (job.status !== "closed" || !job.closedAt || retentionDays == null) return null;
  return new Date(job.closedAt.getTime() + retentionDays * DAY_MS);
}

/** The company's retention period in days, or null when retention is off (or the company is missing). */
export function getCompanyRetentionDays(companyId: string): number | null {
  return db.select({ days: companies.retentionDays }).from(companies).where(eq(companies.id, companyId)).get()?.days ?? null;
}

/** Deletes every candidate whose retention period has passed. Returns how many were deleted. */
export async function purgeExpiredCandidateData(now: Date = new Date()): Promise<number> {
  // The clock starts at the later of "job closed" and "CV added", so a late upload isn't deleted on arrival.
  const expiresAt = sql`max(${jobs.closedAt}, ${candidates.createdAt}) + ${companies.retentionDays} * ${DAY_MS}`;
  const expired = db
    .select({ id: candidates.id, cvFileKey: candidates.cvFileKey })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .innerJoin(companies, eq(companies.id, candidates.companyId))
    .where(
      and(
        eq(jobs.status, "closed"),
        isNotNull(jobs.closedAt),
        isNotNull(companies.retentionDays),
        sql`${expiresAt} <= ${now.getTime()}`,
      ),
    )
    .all();
  if (expired.length === 0) return 0;

  for (let i = 0; i < expired.length; i += 500) {
    const ids = expired.slice(i, i + 500).map((c) => c.id);
    db.delete(candidates).where(inArray(candidates.id, ids)).run();
  }
  for (const { cvFileKey } of expired) {
    try {
      await deleteCvFile(cvFileKey);
    } catch (err) {
      console.error(`[retention] could not delete CV file ${cvFileKey}:`, err instanceof Error ? err.message : err);
    }
  }
  // Flush deleted pages out of the WAL so secure_delete's zeroing reaches the main db file promptly.
  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  return expired.length;
}

/** Runs a purge now and then hourly. Idempotent per process. Called from instrumentation on boot. */
export function startRetentionSweeper(): void {
  const g = globalThis as unknown as { __cvRetentionTimer?: ReturnType<typeof setInterval> };
  if (g.__cvRetentionTimer) return;

  const sweep = () =>
    purgeExpiredCandidateData()
      .then((n) => {
        if (n > 0) console.info(`[retention] deleted ${n} candidate(s) past their retention period`);
      })
      .catch((err) => console.error("[retention] sweep failed:", err instanceof Error ? err.stack : err));

  void sweep();
  g.__cvRetentionTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  g.__cvRetentionTimer.unref();
}
