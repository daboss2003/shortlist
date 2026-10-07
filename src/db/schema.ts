import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { CandidateProfile, Evaluation } from "@/lib/ai/schemas";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const companies = sqliteTable("companies", {
  id: id(),
  name: text("name").notNull(),
  // Shown on the public apply page so applicants can verify the employer is real.
  website: text("website"),
  createdAt: createdAt(),
});

export const users = sqliteTable("users", {
  id: id(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Stored lowercased; uniqueness is global so login needs no company selector.
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    // sha256(token) — the raw token only ever lives in the cookie.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "internship", "temporary"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const JOB_STATUSES = ["open", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Unguessable public identifier used in the /apply/[slug] link.
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    department: text("department"),
    location: text("location"),
    employmentType: text("employment_type", { enum: EMPLOYMENT_TYPES }),
    description: text("description").notNull(),
    requirements: text("requirements").notNull().default(""),
    skills: text("skills", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    minExperienceYears: integer("min_experience_years"),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index("jobs_company_idx").on(t.companyId)],
);

/** Where a candidate came from: the public apply link, or an employer bulk upload. */
export const CANDIDATE_SOURCES = ["public", "upload"] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** AI pipeline state. */
export const CANDIDATE_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Employer's review decision. */
export const CANDIDATE_STAGES = ["new", "shortlisted", "rejected"] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export const candidates = sqliteTable(
  "candidates",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    // Denormalized from jobs.company_id so every candidate query can be tenant-scoped directly.
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    source: text("source", { enum: CANDIDATE_SOURCES }).notNull(),
    // For public applicants these are what they typed; for uploads they are filled from the AI profile.
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    cvFileKey: text("cv_file_key").notNull(),
    cvFileName: text("cv_file_name").notNull(),
    cvMimeType: text("cv_mime_type").notNull(),
    cvSize: integer("cv_size").notNull(),
    cvText: text("cv_text"),
    profile: text("profile", { mode: "json" }).$type<CandidateProfile>(),
    evaluation: text("evaluation", { mode: "json" }).$type<Evaluation>(),
    score: integer("score"),
    status: text("status", { enum: CANDIDATE_STATUSES }).notNull().default("pending"),
    error: text("error"),
    aiProvider: text("ai_provider"),
    aiModel: text("ai_model"),
    stage: text("stage", { enum: CANDIDATE_STAGES }).notNull().default("new"),
    createdAt: createdAt(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("candidates_job_score_idx").on(t.jobId, t.score),
    index("candidates_company_idx").on(t.companyId),
    index("candidates_status_idx").on(t.status),
    // One public application per email per job. Employer uploads are exempt (duplicates are their call).
    uniqueIndex("candidates_public_job_email_uq")
      .on(t.jobId, t.email)
      .where(sql`source = 'public'`),
  ],
);

export type Company = typeof companies.$inferSelect;
export type User = typeof users.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Candidate = typeof candidates.$inferSelect;
export type NewCandidate = typeof candidates.$inferInsert;
