import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { EMPLOYMENT_TYPES, candidates, jobs, type Job, type JobStatus } from "@/db/schema";
import { deleteCvFilesFirst } from "@/lib/candidates/review";
import { safeText } from "@/lib/validation";

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
  safeText()
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
      .array(safeText().max(JOB_LIMITS.skillLength, `Keep each skill under ${JOB_LIMITS.skillLength} characters.`))
      .max(JOB_LIMITS.skills, `Add up to ${JOB_LIMITS.skills} skills.`),
  );

const yearsError = `Enter a whole number of years from 0 to ${JOB_LIMITS.maxYears}.`;
const minYearsSchema = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null || (typeof v === "string" && v.trim() === "") ? null : Number(v)))
  .pipe(z.number({ error: yearsError }).int(yearsError).min(0, yearsError).max(JOB_LIMITS.maxYears, yearsError).nullable());

export const jobInputSchema = z.object({
  title: safeText()
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
  description: safeText()
    .trim()
    .min(1, "Describe the role.")
    .max(JOB_LIMITS.description, "Keep the description under 20,000 characters."),
  requirements: safeText()
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

/** Candidate ids per DELETE … IN (…), well under Postgres's bind-parameter limit. */
const DELETE_ID_BATCH = 1000;

/**
 * - "deleted": the job, its candidates and their CV files are gone.
 * - "not-found": missing or another company's job.
 * - "incomplete": some CV files couldn't be deleted (or time ran out). The job is kept, with the candidates whose
 *   file is still stored; calling again finishes the job.
 */
export type DeleteJobResult = "deleted" | "not-found" | "incomplete";

/** Deletes the job's CV files, then the job (candidates cascade). */
export async function deleteJob(companyId: string, jobId: string): Promise<DeleteJobResult> {
  return db.transaction(async (tx) => {
    // Lock the job row first. A candidate insert takes a key-share lock on its job (the foreign key check), so this
    // waits for in-flight applications to commit and blocks new ones until the transaction ends (if the job is then
    // gone they fail the FK check and remove their own file). The rows read next are therefore all the job has.
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(ownJob(companyId, jobId)).for("update");
    if (!job) return "not-found";
    const rows = await tx
      .select({ id: candidates.id, cvFileKey: candidates.cvFileKey })
      .from(candidates)
      .where(and(eq(candidates.companyId, companyId), eq(candidates.jobId, job.id)));

    // Intentional: files first, then rows (as in retention.ts). Deleting the rows first would leave any file that
    // then fails to delete, or that a timeout cuts off, in storage with nothing pointing at it, never to be removed.
    const { deleted, failed } = await deleteCvFilesFirst(rows);
    if (failed.length === 0) {
      await tx.delete(jobs).where(ownJob(companyId, job.id));
      return "deleted";
    }
    // Keep the job and the candidates whose file is still stored; drop the ones whose file is gone, so a retry
    // has only the rest to do and a job too big for one request still gets deleted over a few.
    for (let i = 0; i < deleted.length; i += DELETE_ID_BATCH) {
      const ids = deleted.slice(i, i + DELETE_ID_BATCH).map((row) => row.id);
      await tx
        .delete(candidates)
        .where(and(eq(candidates.companyId, companyId), eq(candidates.jobId, job.id), inArray(candidates.id, ids)));
    }
    return "incomplete";
  });
}
