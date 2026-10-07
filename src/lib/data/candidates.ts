import "server-only";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { candidates, jobs, type Candidate, type CandidateStage, type Job } from "@/db/schema";

// Tenant-scoped by companyId. Same Cache Components rule as data/jobs.ts.

export type CandidateListOptions = {
  stage?: CandidateStage;
  /** Restrict to these ids (still scoped to the job + company, so foreign ids are silently dropped). */
  ids?: string[];
};

/** Ranked list: highest score first, unscored (pending/failed) last, then oldest first. */
export function listCandidatesForJob(companyId: string, jobId: string, opts: CandidateListOptions = {}): Candidate[] {
  const where: SQL[] = [eq(candidates.companyId, companyId), eq(candidates.jobId, jobId)];
  if (opts.stage) where.push(eq(candidates.stage, opts.stage));
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where.push(inArray(candidates.id, opts.ids));
  }
  return db
    .select()
    .from(candidates)
    .where(and(...where))
    .orderBy(sql`${candidates.score} is null`, sql`${candidates.score} desc`, asc(candidates.createdAt))
    .all();
}

export type CandidateWithJob = Candidate & { job: Job };

export function getCandidateForCompany(companyId: string, candidateId: string): CandidateWithJob | null {
  const row = db
    .select({ candidate: candidates, job: jobs })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .where(and(eq(candidates.id, candidateId), eq(candidates.companyId, companyId)))
    .get();
  return row ? { ...row.candidate, job: row.job } : null;
}
