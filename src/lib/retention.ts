import "server-only";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { candidates, companies, jobs, type JobStatus } from "@/db/schema";
import { describeError } from "@/lib/log";
import { deleteCvFile } from "@/lib/storage";

// Candidate data retention: once a job has been closed for the company's retention period, every
// candidate on it (row = extracted text, profile, evaluation; plus the CV file) is permanently deleted.
// The job itself is kept — it holds no applicant data.

/** Choices offered in Settings. `null` (Off) keeps data until deleted manually. */
export const RETENTION_DAY_OPTIONS = [30, 90, 180] as const;
export type RetentionDays = (typeof RETENTION_DAY_OPTIONS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Candidates per purge: one batch fits a 60 s serverless invocation (file deletes are network calls on Blobs). */
const PURGE_BATCH = 500;
const FILE_DELETE_CONCURRENCY = 10;

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
export async function getCompanyRetentionDays(companyId: string): Promise<number | null> {
  const [row] = await db
    .select({ days: companies.retentionDays })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row?.days ?? null;
}

/**
 * Deletes up to `limit` (default 500) candidates whose retention period has passed, oldest first. Returns how
 * many were deleted; when that equals the limit there may be more for the next run.
 */
export async function purgeExpiredCandidateData(now: Date = new Date(), { limit = PURGE_BATCH } = {}): Promise<number> {
  // The clock starts at the later of "job closed" and "CV added", so a late upload isn't deleted on arrival.
  const expiresAt = sql`greatest(${jobs.closedAt}, ${candidates.createdAt}) + ${companies.retentionDays} * interval '1 day'`;
  const expired = await db
    .select({ id: candidates.id, cvFileKey: candidates.cvFileKey })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .innerJoin(companies, eq(companies.id, candidates.companyId))
    .where(
      and(
        eq(jobs.status, "closed"),
        isNotNull(jobs.closedAt),
        isNotNull(companies.retentionDays),
        sql`${expiresAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(candidates.createdAt))
    .limit(limit);
  if (expired.length === 0) return 0;

  // Intentional: files first, then rows. A file that fails to delete keeps its row, so the next run retries it;
  // deleting the rows first would leave that CV in storage with nothing pointing at it, never to be purged.
  const deletable: string[] = [];
  for (let i = 0; i < expired.length; i += FILE_DELETE_CONCURRENCY) {
    const chunk = expired.slice(i, i + FILE_DELETE_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(({ cvFileKey }) => deleteCvFile(cvFileKey)));
    results.forEach((result, j) => {
      if (result.status === "fulfilled") deletable.push(chunk[j].id);
      else console.error(`[retention] could not delete CV file ${chunk[j].cvFileKey}:`, describeError(result.reason));
    });
  }
  if (deletable.length === 0) return 0;

  const deleted = await db
    .delete(candidates)
    .where(inArray(candidates.id, deletable))
    .returning({ id: candidates.id });
  return deleted.length;
}

/** Long-lived (in-process) mode only: purges now and then hourly. On serverless an Inngest cron does this. */
export function startRetentionSweeper(): void {
  const g = globalThis as unknown as { __cvRetentionTimer?: ReturnType<typeof setInterval> };
  if (g.__cvRetentionTimer) return;

  const sweep = async () => {
    try {
      let total = 0;
      // Batches until the backlog is gone; a batch that deletes fewer than PURGE_BATCH means it is.
      for (let n = PURGE_BATCH; n === PURGE_BATCH; total += n) n = await purgeExpiredCandidateData();
      if (total > 0) console.info(`[retention] deleted ${total} candidate(s) past their retention period`);
    } catch (err) {
      console.error("[retention] sweep failed:", describeError(err, { withStack: true }));
    }
  };

  void sweep();
  g.__cvRetentionTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  g.__cvRetentionTimer.unref();
}
