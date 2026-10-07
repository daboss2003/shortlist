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

export function listJobsWithStats(companyId: string): JobWithStats[] {
  return db
    .select({
      job: jobs,
      candidateCount: sql<number>`count(${candidates.id})`,
      readyCount: sql<number>`count(case when ${candidates.status} = 'ready' then 1 end)`,
      pendingCount: sql<number>`count(case when ${candidates.status} in ('pending','processing') then 1 end)`,
      shortlistedCount: sql<number>`count(case when ${candidates.stage} = 'shortlisted' then 1 end)`,
      topScore: sql<number | null>`max(${candidates.score})`,
    })
    .from(jobs)
    .leftJoin(candidates, eq(candidates.jobId, jobs.id))
    .where(eq(jobs.companyId, companyId))
    .groupBy(jobs.id)
    .orderBy(desc(jobs.createdAt))
    .all()
    .map(({ job, ...stats }) => ({ ...job, ...stats }));
}

export function getJobForCompany(companyId: string, jobId: string): Job | null {
  return db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.companyId, companyId))).get() ?? null;
}

export type PublicJob = Job & { companyName: string; companyWebsite: string | null };

/** Public apply page lookup. Returns closed jobs too so the page can say the role is closed. */
export function getPublicJobBySlug(slug: string): PublicJob | null {
  const row = db
    .select({ job: jobs, companyName: companies.name, companyWebsite: companies.website })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.slug, slug))
    .get();
  return row ? { ...row.job, companyName: row.companyName, companyWebsite: row.companyWebsite } : null;
}
