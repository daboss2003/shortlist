import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { candidates, companies, jobs, type Job } from "@/db/schema";

// Every function here is tenant-scoped by companyId except the public slug lookup.
// With Cache Components on, call these only after a request-time API (requireEmployer(), awaited params, connection()).

export type JobWithStats = Job & {
  candidateCount: number;
  readyCount: number;
  pendingCount: number;
  shortlistedCount: number;
  topScore: number | null;
};

export async function listJobsWithStats(companyId: string): Promise<JobWithStats[]> {
  // Intentional: ::int casts — Postgres count() is bigint, which drivers return as a string.
  const rows = await db
    .select({
      job: jobs,
      candidateCount: sql<number>`count(${candidates.id})::int`,
      readyCount: sql<number>`count(case when ${candidates.status} = 'ready' then 1 end)::int`,
      pendingCount: sql<number>`count(case when ${candidates.status} in ('pending','processing') then 1 end)::int`,
      shortlistedCount: sql<number>`count(case when ${candidates.stage} = 'shortlisted' then 1 end)::int`,
      topScore: sql<number | null>`max(${candidates.score})::int`,
    })
    .from(jobs)
    .leftJoin(candidates, eq(candidates.jobId, jobs.id))
    .where(eq(jobs.companyId, companyId))
    .groupBy(jobs.id)
    .orderBy(desc(jobs.createdAt));
  return rows.map(({ job, ...stats }) => ({ ...job, ...stats }));
}

/**
 * Ids and slugs come from URLs. Postgres rejects NUL in text (error 22021), so a hostile value would surface as a
 * 500; a malformed id must behave like a missing one.
 */
export const isLookupSafe = (value: string) => value.length > 0 && value.length <= 200 && !value.includes("\u0000");

export async function getJobForCompany(companyId: string, jobId: string): Promise<Job | null> {
  if (!isLookupSafe(jobId)) return null;
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.companyId, companyId)))
    .limit(1);
  return job ?? null;
}

export type PublicJob = Job & {
  companyName: string;
  companyWebsite: string | null;
  /** Days after the job closes before applicants' data is deleted; null = retention off. */
  companyRetentionDays: number | null;
};

/** Public apply page lookup. Returns closed jobs too so the page can say the role is closed. */
export async function getPublicJobBySlug(slug: string): Promise<PublicJob | null> {
  if (!isLookupSafe(slug)) return null;
  const [row] = await db
    .select({
      job: jobs,
      companyName: companies.name,
      companyWebsite: companies.website,
      companyRetentionDays: companies.retentionDays,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.slug, slug))
    .limit(1);
  return row
    ? {
        ...row.job,
        companyName: row.companyName,
        companyWebsite: row.companyWebsite,
        companyRetentionDays: row.companyRetentionDays,
      }
    : null;
}
