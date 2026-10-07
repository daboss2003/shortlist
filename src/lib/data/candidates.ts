import "server-only";
import { and, asc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { candidates, jobs, type Candidate, type CandidateStage, type Job } from "@/db/schema";

// Tenant-scoped by companyId. Same Cache Components rule as data/jobs.ts.

/** A candidate as listed in tables and exports: everything except the (potentially large) extracted CV text. */
export type CandidateListItem = Omit<Candidate, "cvText">;

/** A listed candidate plus its rank: 1-based position among *scored* candidates in the job (or stage), null if unscored. */
export type RankedCandidate = CandidateListItem & { rank: number | null };

export type CandidateListOptions = {
  stage?: CandidateStage;
  /**
   * Restrict the result to these ids (foreign ids are silently dropped). Ranks are still computed over the
   * whole job/stage first, so an exported subset keeps the ranks shown on screen.
   */
  ids?: string[];
};

const { cvText: _omit, ...listColumns } = getTableColumns(candidates);
void _omit;

/** Ranked list: highest score first, unscored (pending/failed) last, then oldest first, then id (stable). */
export async function listCandidatesForJob(
  companyId: string,
  jobId: string,
  opts: CandidateListOptions = {},
): Promise<RankedCandidate[]> {
  const where: SQL[] = [eq(candidates.companyId, companyId), eq(candidates.jobId, jobId)];
  if (opts.stage) where.push(eq(candidates.stage, opts.stage));
  const rows = await db
    .select(listColumns)
    .from(candidates)
    .where(and(...where))
    .orderBy(sql`${candidates.score} is null`, sql`${candidates.score} desc`, asc(candidates.createdAt), asc(candidates.id));

  let next = 0;
  const ranked = rows.map((c) => ({ ...c, rank: c.score === null ? null : ++next }));
  if (!opts.ids) return ranked;
  const wanted = new Set(opts.ids);
  return ranked.filter((c) => wanted.has(c.id));
}

export type CandidateWithJob = Candidate & { job: Job };

export async function getCandidateForCompany(companyId: string, candidateId: string): Promise<CandidateWithJob | null> {
  const [row] = await db
    .select({ candidate: candidates, job: jobs })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .where(and(eq(candidates.id, candidateId), eq(candidates.companyId, companyId)))
    .limit(1);
  return row ? { ...row.candidate, job: row.job } : null;
}
