import "server-only";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { candidates, type Candidate, type CandidateStage } from "@/db/schema";
import { describeError } from "@/lib/log";
import { deleteCvFile } from "@/lib/storage";

// Employer review mutations. Every query is scoped by companyId (and jobId where given), so
// foreign ids are silently ignored. Callers authenticate and validate input first.

/** Moves candidates of one job to a review stage. Returns the number of rows updated. */
export async function setCandidatesStage(
  companyId: string,
  jobId: string,
  ids: string[],
  stage: CandidateStage,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(candidates)
    .set({ stage })
    .where(and(eq(candidates.companyId, companyId), eq(candidates.jobId, jobId), inArray(candidates.id, ids)))
    .returning({ id: candidates.id });
  return rows.length;
}

/**
 * Re-queues candidates for AI analysis: status → pending, error cleared, attempts and busy-AI retries reset.
 * claim_token/claimed_at are kept (process-cv event ids are derived from them; see processEventId).
 * Returns the ids to pass to scheduleCandidateProcessing().
 */
export async function markForRescore(companyId: string, jobId: string, ids: string[] | "all"): Promise<string[]> {
  if (ids !== "all" && ids.length === 0) return [];
  const where: SQL[] = [eq(candidates.companyId, companyId), eq(candidates.jobId, jobId)];
  if (ids !== "all") where.push(inArray(candidates.id, ids));
  // Intentional: rows currently "processing" are included. That run may be using an outdated job
  // description; the pipeline sees the row went back to "pending", discards the superseded result and
  // runs it again. cvText, profile, evaluation and score are kept — the pipeline skips re-extraction
  // when cvText exists, and the stale ranking stays visible until the new one lands.
  const rows = await db
    .update(candidates)
    .set({ status: "pending", error: null, attempts: 0, aiRetries: 0 })
    .where(and(...where))
    .returning({ id: candidates.id });
  return rows.map((row) => row.id);
}

/** CV deletes in flight at once. On Netlify Blobs each one is a network call. */
const FILE_DELETE_CONCURRENCY = 8;
/**
 * No new CV delete starts after this long. A Blobs call that is being retried can take ~25 s more (5 retries,
 * 5 s apart), and the whole request must finish inside Netlify's 60 s.
 */
const FILE_DELETE_BUDGET_MS = 25_000;

/**
 * Deletes each row's stored CV, `concurrency` at a time, starting none after `deadline`. A file that was already
 * missing counts as deleted (deleteCvFile is idempotent). `failed` holds the rows whose file couldn't be deleted or
 * wasn't reached in time; both lists keep the input order.
 *
 * Callers delete the rows in `deleted` only, and keep the rest, so a CV file is never left with no row pointing to
 * it: the next attempt finds the kept rows and retries their files.
 */
export async function deleteCvFilesFirst<T extends { cvFileKey: string }>(
  rows: T[],
  { concurrency = FILE_DELETE_CONCURRENCY, deadline = Date.now() + FILE_DELETE_BUDGET_MS } = {},
): Promise<{ deleted: T[]; failed: T[] }> {
  const gone = new Array<boolean>(rows.length).fill(false);
  let next = 0;

  async function worker() {
    while (next < rows.length && Date.now() < deadline) {
      const index = next++;
      const { cvFileKey } = rows[index];
      try {
        await deleteCvFile(cvFileKey);
        gone[index] = true;
      } catch (err) {
        console.error(`[review] could not delete CV file ${cvFileKey}:`, describeError(err));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return { deleted: rows.filter((_, i) => gone[i]), failed: rows.filter((_, i) => !gone[i]) };
}

/** Some CV files couldn't be deleted, so their candidates were kept; the others were deleted. Message is user-safe. */
export class CandidateDeleteIncompleteError extends Error {
  constructor(
    readonly deleted: number,
    readonly total: number,
  ) {
    super(
      deleted > 0
        ? `Deleted ${deleted} of ${total}; try again for the rest.`
        : `Couldn't delete the CV ${total === 1 ? "file" : "files"}. Try again.`,
    );
  }
}

/**
 * Deletes the candidate's stored CV, then its row. Returns false for a missing or foreign id. Throws
 * CandidateDeleteIncompleteError (and keeps the candidate) when the file can't be deleted.
 */
export async function deleteCandidate(companyId: string, candidateId: string): Promise<boolean> {
  const own = and(eq(candidates.id, candidateId), eq(candidates.companyId, companyId));
  const [row] = await db.select({ cvFileKey: candidates.cvFileKey }).from(candidates).where(own).limit(1);
  if (!row) return false;
  const { failed } = await deleteCvFilesFirst([row]);
  if (failed.length > 0) throw new CandidateDeleteIncompleteError(0, 1);
  const deleted = await db.delete(candidates).where(own).returning({ id: candidates.id });
  return deleted.length > 0;
}

/**
 * Deletes candidates of one job: their stored CVs first, then the rows whose file is gone. Returns the number of
 * candidates deleted. When some files can't be deleted (or time runs out), those candidates are kept and
 * CandidateDeleteIncompleteError is thrown after the others are deleted; calling again finishes the job.
 */
export async function deleteCandidates(companyId: string, jobId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const inJob = (rowIds: string[]) =>
    and(eq(candidates.companyId, companyId), eq(candidates.jobId, jobId), inArray(candidates.id, rowIds));
  const rows = await db
    .select({ id: candidates.id, cvFileKey: candidates.cvFileKey })
    .from(candidates)
    .where(inJob(ids));
  if (rows.length === 0) return 0;

  const { deleted: filesGone, failed } = await deleteCvFilesFirst(rows);
  const deleted =
    filesGone.length > 0
      ? await db
          .delete(candidates)
          .where(inJob(filesGone.map((row) => row.id)))
          .returning({ id: candidates.id })
      : [];
  // Intentional: thrown after the partial delete, not returned as a count — a caller that only reads the count would
  // otherwise report a partial delete as complete.
  if (failed.length > 0) throw new CandidateDeleteIncompleteError(deleted.length, rows.length);
  return deleted.length;
}

/** Typed name (public applicants), else the name the AI found in the CV, else the file name. */
export function candidateDisplayName(c: Pick<Candidate, "name" | "profile" | "cvFileName">): string {
  return c.name?.trim() || c.profile?.fullName?.trim() || c.cvFileName;
}
