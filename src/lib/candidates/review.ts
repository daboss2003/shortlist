import "server-only";
import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { candidates, type Candidate, type CandidateStage } from "@/db/schema";
import { deleteCvFile } from "@/lib/storage";

// Employer review mutations. Every query is scoped by companyId (and jobId where given), so
// foreign ids are silently ignored. Callers authenticate and validate input first.

/** Moves candidates of one job to a review stage. Returns the number of rows updated. */
export function setCandidatesStage(companyId: string, jobId: string, ids: string[], stage: CandidateStage): number {
  if (ids.length === 0) return 0;
  return db
    .update(candidates)
    .set({ stage })
    .where(and(eq(candidates.companyId, companyId), eq(candidates.jobId, jobId), inArray(candidates.id, ids)))
    .run().changes;
}

/**
 * Re-queues candidates for AI analysis: status → pending, error cleared. Rows already processing
 * are skipped. Returns the ids to pass to scheduleCandidateProcessing().
 */
export function markForRescore(companyId: string, jobId: string, ids: string[] | "all"): string[] {
  if (ids !== "all" && ids.length === 0) return [];
  const where: SQL[] = [
    eq(candidates.companyId, companyId),
    eq(candidates.jobId, jobId),
    ne(candidates.status, "processing"),
  ];
  if (ids !== "all") where.push(inArray(candidates.id, ids));
  // Intentional: cvText, profile, evaluation and score are kept — the pipeline skips re-extraction
  // when cvText exists, and the stale ranking stays visible until the new one lands.
  return db
    .update(candidates)
    .set({ status: "pending", error: null })
    .where(and(...where))
    .returning({ id: candidates.id })
    .all()
    .map((row) => row.id);
}

/** Deletes the candidate row, then its stored CV. Returns false for a missing or foreign id. */
export async function deleteCandidate(companyId: string, candidateId: string): Promise<boolean> {
  const row = db
    .delete(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.companyId, companyId)))
    .returning({ cvFileKey: candidates.cvFileKey })
    .get();
  if (!row) return false;
  await deleteCvFile(row.cvFileKey);
  return true;
}

/** Typed name (public applicants), else the name the AI found in the CV, else the file name. */
export function candidateDisplayName(c: Pick<Candidate, "name" | "profile" | "cvFileName">): string {
  return c.name?.trim() || c.profile?.fullName?.trim() || c.cvFileName;
}
