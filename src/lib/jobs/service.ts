import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { EMPLOYMENT_TYPES, candidates, jobs, type Job, type JobStatus } from "@/db/schema";
import { deleteCvFile } from "@/lib/storage";

// Employer-side job writes. Every function is scoped by companyId: a foreign job behaves exactly like a missing one.

export const JOB_LIMITS = {
  title: 120,
  department: 120,
  location: 120,
  description: 20_000,
  requirements: 20_000,
  skills: 30,
  skillLength: 60,
  maxYears: 50,
} as const;

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `Keep the ${label} under ${max} characters.`)
    .nullish()
    .transform((v) => v || null);

const skillsSchema = z
  .union([z.string(), z.array(z.string())])
  .nullish()
  .transform((value) => {
    const parts = typeof value === "string" ? value.split(/[,\n]/) : (value ?? []);
    const seen = new Set<string>();
    const skills: string[] = [];
    for (const raw of parts) {
      const skill = raw.trim();
      const key = skill.toLowerCase();
      if (!skill || seen.has(key)) continue;
      seen.add(key);
      skills.push(skill);
    }
    return skills;
  })
  .pipe(
    z
      .array(z.string().max(JOB_LIMITS.skillLength, `Keep each skill under ${JOB_LIMITS.skillLength} characters.`))
      .max(JOB_LIMITS.skills, `Add up to ${JOB_LIMITS.skills} skills.`),
  );

const yearsError = `Enter a whole number of years from 0 to ${JOB_LIMITS.maxYears}.`;
const minYearsSchema = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null || (typeof v === "string" && v.trim() === "") ? null : Number(v)))
  .pipe(z.number({ error: yearsError }).int(yearsError).min(0, yearsError).max(JOB_LIMITS.maxYears, yearsError).nullable());

export const jobInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Enter a job title.")
    .max(JOB_LIMITS.title, `Keep the title under ${JOB_LIMITS.title} characters.`),
  department: optionalText(JOB_LIMITS.department, "department"),
  location: optionalText(JOB_LIMITS.location, "location"),
  employmentType: z
    .string()
    .nullish()
    .transform((v) => v || null)
    .pipe(z.enum(EMPLOYMENT_TYPES, { error: "Choose an employment type from the list." }).nullable()),
  description: z
    .string()
    .trim()
    .min(1, "Describe the role.")
    .max(JOB_LIMITS.description, "Keep the description under 20,000 characters."),
  requirements: z
    .string()
    .trim()
    .max(JOB_LIMITS.requirements, "Keep the requirements under 20,000 characters.")
    .nullish()
    .transform((v) => v ?? ""),
  skills: skillsSchema,
  minExperienceYears: minYearsSchema,
});

/** Raw form/API input (strings, as submitted). */
export type JobInput = z.input<typeof jobInputSchema>;
/** Validated, normalized job fields. */
export type JobData = z.output<typeof jobInputSchema>;
export type JobField = keyof JobData;
export type JobFieldErrors = Partial<Record<JobField, string>>;

export function parseJobInput(input: unknown): { ok: true; data: JobData } | { ok: false; fieldErrors: JobFieldErrors } {
  const result = jobInputSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const { fieldErrors } = z.flattenError(result.error);
  return {
    ok: false,
    fieldErrors: Object.fromEntries(
      Object.entries(fieldErrors).map(([field, messages]) => [field, messages?.[0]]),
    ) as JobFieldErrors,
  };
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSlugSuffix(length = 10): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // Intentional: reject bytes >= 252 (7 × 36) so every character is equally likely (no modulo bias).
      if (byte < 252 && out.length < length) out += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
    }
  }
  return out;
}

/** Public, unguessable identifier for the /apply link: readable prefix + 10 random chars (~52 bits). */
function makeJobSlug(title: string): string {
  const prefix = slugify(title).slice(0, 48).replace(/-+$/, "") || "job";
  return `${prefix}-${randomSlugSuffix()}`;
}

const ownJob = (companyId: string, jobId: string) => and(eq(jobs.id, jobId), eq(jobs.companyId, companyId));

export async function createJob(companyId: string, data: JobData): Promise<Job> {
  const [job] = await db
    .insert(jobs)
    .values({ ...data, companyId, slug: makeJobSlug(data.title) })
    .returning();
  return job;
}

/** The slug is deliberately left alone so links already shared keep working. */
export async function updateJob(companyId: string, jobId: string, data: JobData): Promise<Job | null> {
  const [job] = await db.update(jobs).set(data).where(ownJob(companyId, jobId)).returning();
  return job ?? null;
}

/** Closing starts the candidate-data retention clock (kept as-is if already closed); reopening stops it. */
export async function setJobStatus(companyId: string, jobId: string, status: JobStatus): Promise<boolean> {
  const closedAt = status === "closed" ? sql`coalesce(${jobs.closedAt}, ${new Date().toISOString()}::timestamptz)` : null;
  const updated = await db
    .update(jobs)
    .set({ status, closedAt })
    .where(ownJob(companyId, jobId))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

/** The company's most recently created job, or null. The new-job page keys its form on it. */
export async function newestJobId(companyId: string): Promise<string | null> {
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.companyId, companyId))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1);
  return job?.id ?? null;
}

export async function countJobCandidates(companyId: string, jobId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(candidates)
    .where(and(eq(candidates.companyId, companyId), eq(candidates.jobId, jobId)));
  return row?.n ?? 0;
}

/** Deletes the job (candidates cascade) and then its candidates' CV files. */
export async function deleteJob(companyId: string, jobId: string): Promise<boolean> {
  const fileKeys = await db.transaction(async (tx) => {
    // Lock the job row first. A candidate insert takes a key-share lock on its job (the foreign key check), so this
    // waits for in-flight applications to commit and blocks new ones until the job is gone (they then fail the FK
    // check and remove their own file). The keys read next are therefore exactly the candidates the cascade deletes,
    // and no CV file is left behind unreferenced.
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(ownJob(companyId, jobId)).for("update");
    if (!job) return null;
    const rows = await tx
      .select({ key: candidates.cvFileKey })
      .from(candidates)
      .where(and(eq(candidates.companyId, companyId), eq(candidates.jobId, job.id)));
    await tx.delete(jobs).where(ownJob(companyId, job.id));
    return rows.map((r) => r.key);
  });
  if (!fileKeys) return false;

  const results = await Promise.allSettled(fileKeys.map((key) => deleteCvFile(key)));
  for (const [i, r] of results.entries()) {
    // Intentional: the DB delete is the source of truth; a file that can't be removed is logged, not fatal.
    if (r.status === "rejected") console.error(`Failed to delete CV file ${fileKeys[i]}`, r.reason);
  }
  return true;
}
