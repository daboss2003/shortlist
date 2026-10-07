import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates, jobs } from "@/db/schema";
import { createCandidateFromCv, type ValidatedCv } from "@/lib/candidates/intake";
import { cvFileExists } from "@/lib/storage";
import { makeCompany } from "../../../test/factories";
import {
  countJobCandidates,
  createJob,
  deleteJob,
  newestJobId,
  parseJobInput,
  setJobStatus,
  slugify,
  updateJob,
  type JobData,
} from "./service";

const validForm = (overrides: Record<string, unknown> = {}) => ({
  title: "Senior Backend Engineer",
  department: "Engineering",
  location: "Lagos, Nigeria · Hybrid",
  employmentType: "full_time",
  description: "Build and run our payments APIs.",
  requirements: "5+ years Node.js and PostgreSQL.",
  skills: "Node.js, TypeScript, PostgreSQL",
  minExperienceYears: "5",
  ...overrides,
});

function parse(overrides: Record<string, unknown> = {}): JobData {
  const result = parseJobInput(validForm(overrides));
  if (!result.ok) throw new Error(`expected valid input, got ${JSON.stringify(result.fieldErrors)}`);
  return result.data;
}

function errorsFor(overrides: Record<string, unknown>) {
  const result = parseJobInput(validForm(overrides));
  if (result.ok) throw new Error("expected validation to fail");
  return result.fieldErrors;
}

const pdfCv = (): ValidatedCv => {
  const bytes = Buffer.from("%PDF-1.4\n% test cv\n");
  return {
    bytes,
    fileName: "cv.pdf",
    fileType: "pdf",
    mimeType: "application/pdf",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const jobRow = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];

describe("parseJobInput", () => {
  it("trims text and turns blank optional fields into null", () => {
    const data = parse({
      title: "  Product Designer  ",
      department: "   ",
      location: "",
      employmentType: "",
      requirements: "",
      skills: "",
      minExperienceYears: "",
    });
    expect(data).toEqual({
      title: "Product Designer",
      department: null,
      location: null,
      employmentType: null,
      description: "Build and run our payments APIs.",
      requirements: "",
      skills: [],
      minExperienceYears: null,
    });
  });

  it("splits skills on commas and new lines, trims, drops blanks and dedupes case-insensitively", () => {
    expect(parse({ skills: " React, typescript ,, TypeScript,\nreact ,GraphQL , " }).skills).toEqual([
      "React",
      "typescript",
      "GraphQL",
    ]);
    expect(parse({ skills: ["Go", " go ", "Rust"] }).skills).toEqual(["Go", "Rust"]);
  });

  it("limits skills to 30, each up to 60 characters", () => {
    const thirty = Array.from({ length: 30 }, (_, i) => `Skill ${i}`).join(",");
    expect(parse({ skills: thirty }).skills).toHaveLength(30);
    expect(errorsFor({ skills: `${thirty}, One more` }).skills).toMatch(/30/);
    expect(errorsFor({ skills: `Go, ${"x".repeat(61)}` }).skills).toMatch(/60/);
  });

  it("accepts whole years from 0 to 50", () => {
    expect(parse({ minExperienceYears: "0" }).minExperienceYears).toBe(0);
    expect(parse({ minExperienceYears: " 12 " }).minExperienceYears).toBe(12);
    expect(parse({ minExperienceYears: 50 }).minExperienceYears).toBe(50);
    for (const bad of ["-1", "51", "2.5", "five"]) {
      expect(errorsFor({ minExperienceYears: bad }).minExperienceYears).toBeTruthy();
    }
  });

  it("reports a field error for each invalid field", () => {
    const errors = errorsFor({
      title: " ",
      description: "",
      employmentType: "freelance",
      location: "x".repeat(121),
      requirements: "x".repeat(20_001),
    });
    expect(Object.keys(errors).sort()).toEqual(["description", "employmentType", "location", "requirements", "title"]);
    expect(errorsFor({ title: "x".repeat(121) }).title).toMatch(/120/);
    expect(errorsFor({ description: "x".repeat(20_001) }).description).toBeTruthy();
    expect(parse({ title: "x".repeat(120), description: "x".repeat(20_000) }).title).toHaveLength(120);
  });
});

describe("slugs", () => {
  it("slugifies titles to lowercase ASCII words", () => {
    expect(slugify("Ingénieur Logiciel (Senior) — Paris!")).toBe("ingenieur-logiciel-senior-paris");
    expect(slugify("  C++ / Go developer  ")).toBe("c-go-developer");
    expect(slugify("日本語")).toBe("");
  });

  it("is the slugified title (max 48 chars) plus a 10-char random suffix, unique per job", async () => {
    const { company } = await makeCompany();
    const a = await createJob(company.id, parse({ title: "Senior Backend Engineer" }));
    const b = await createJob(company.id, parse({ title: "Senior Backend Engineer" }));
    expect(a.slug).toMatch(/^senior-backend-engineer-[a-z0-9]{10}$/);
    expect(b.slug).toMatch(/^senior-backend-engineer-[a-z0-9]{10}$/);
    expect(a.slug).not.toBe(b.slug);

    const long = await createJob(company.id, parse({ title: "Principal Staff Software Engineer, Payments Infrastructure Platform" }));
    const [prefix] = long.slug.split(/-(?=[a-z0-9]{10}$)/);
    expect(prefix.length).toBeLessThanOrEqual(48);
    expect(prefix.endsWith("-")).toBe(false);
    expect(long.slug).toMatch(/^principal-staff-software-engineer-payments-infra-[a-z0-9]{10}$/);

    expect((await createJob(company.id, parse({ title: "日本語" }))).slug).toMatch(/^job-[a-z0-9]{10}$/);
  });
});

describe("createJob / updateJob", () => {
  it("creates an open job for the company", async () => {
    const { company } = await makeCompany();
    const job = await createJob(company.id, parse());
    expect(job).toMatchObject({
      companyId: company.id,
      status: "open",
      title: "Senior Backend Engineer",
      department: "Engineering",
      location: "Lagos, Nigeria · Hybrid",
      employmentType: "full_time",
      skills: ["Node.js", "TypeScript", "PostgreSQL"],
      minExperienceYears: 5,
    });
    expect(await jobRow(job.id)).toMatchObject({ slug: job.slug, skills: ["Node.js", "TypeScript", "PostgreSQL"] });
  });

  it("updates the fields but never the slug", async () => {
    const { company } = await makeCompany();
    const job = await createJob(company.id, parse());
    const updated = await updateJob(company.id, job.id, parse({ title: "Staff Engineer", skills: "Go", minExperienceYears: "" }));
    expect(updated).toMatchObject({ id: job.id, title: "Staff Engineer", skills: ["Go"], minExperienceYears: null, slug: job.slug });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(job.updatedAt.getTime());
  });

  it("returns null for a missing job or another company's job and leaves it untouched", async () => {
    const a = await makeCompany();
    const b = await makeCompany();
    const job = await createJob(a.company.id, parse());
    expect(await updateJob(b.company.id, job.id, parse({ title: "Hijacked" }))).toBeNull();
    expect(await updateJob(a.company.id, "missing-id", parse())).toBeNull();
    expect((await jobRow(job.id)).title).toBe("Senior Backend Engineer");
  });
});

describe("newestJobId", () => {
  it("is the company's most recently created job, changing with every new job", async () => {
    const a = await makeCompany();
    const b = await makeCompany();
    expect(await newestJobId(a.company.id)).toBeNull();
    const first = await createJob(a.company.id, parse());
    expect(await newestJobId(a.company.id)).toBe(first.id);
    await db.update(jobs).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(jobs.id, first.id));
    const second = await createJob(a.company.id, parse());
    expect(await newestJobId(a.company.id)).toBe(second.id);
    await createJob(b.company.id, parse());
    expect(await newestJobId(a.company.id)).toBe(second.id);
  });
});

describe("setJobStatus", () => {
  it("closes and reopens the company's own job", async () => {
    const { company } = await makeCompany();
    const job = await createJob(company.id, parse());
    expect(await setJobStatus(company.id, job.id, "closed")).toBe(true);
    expect((await jobRow(job.id)).status).toBe("closed");
    expect(await setJobStatus(company.id, job.id, "open")).toBe(true);
    expect((await jobRow(job.id)).status).toBe("open");
  });

  it("starts the retention clock on close, keeps it on a repeat close, and clears it on reopen", async () => {
    const { company } = await makeCompany();
    const job = await createJob(company.id, parse());
    const closedAt = async () => (await jobRow(job.id)).closedAt;
    expect(await closedAt()).toBeNull();

    const before = Date.now();
    await setJobStatus(company.id, job.id, "closed");
    const first = await closedAt();
    expect(first).toBeInstanceOf(Date);
    expect(first!.getTime()).toBeGreaterThanOrEqual(before);
    expect(first!.getTime()).toBeLessThanOrEqual(Date.now());
    await db.update(jobs).set({ closedAt: new Date(first!.getTime() - 1000) }).where(eq(jobs.id, job.id));
    await setJobStatus(company.id, job.id, "closed");
    expect((await closedAt())!.getTime()).toBe(first!.getTime() - 1000);

    await setJobStatus(company.id, job.id, "open");
    expect(await closedAt()).toBeNull();
  });

  it("cannot change another company's job", async () => {
    const a = await makeCompany();
    const b = await makeCompany();
    const job = await createJob(a.company.id, parse());
    expect(await setJobStatus(b.company.id, job.id, "closed")).toBe(false);
    expect(await setJobStatus(a.company.id, "missing-id", "closed")).toBe(false);
    expect((await jobRow(job.id)).status).toBe("open");
  });
});

describe("countJobCandidates", () => {
  it("counts the company's candidates on the job as a number", async () => {
    const { company } = await makeCompany();
    const job = await createJob(company.id, parse());
    expect(await countJobCandidates(company.id, job.id)).toBe(0);
    await createCandidateFromCv({ job, source: "upload", cv: pdfCv() });
    await createCandidateFromCv({ job, source: "upload", cv: { ...pdfCv(), sha256: "b".repeat(64) } });
    const n = await countJobCandidates(company.id, job.id);
    expect(n).toBe(2);
    expect(typeof n).toBe("number");
  });
});

describe("deleteJob", () => {
  it("deletes the job, its candidates and their CV files", async () => {
    const { company } = await makeCompany();
    const job = await createJob(company.id, parse());
    const other = await createJob(company.id, parse({ title: "Keep me" }));
    const c1 = await createCandidateFromCv({ job, source: "upload", cv: pdfCv() });
    const c2 = await createCandidateFromCv({
      job,
      source: "public",
      cv: pdfCv(),
      applicant: { name: "Ada", email: "ada@example.com", phone: null },
    });
    const kept = await createCandidateFromCv({ job: other, source: "upload", cv: pdfCv() });
    expect(await countJobCandidates(company.id, job.id)).toBe(2);
    expect((await cvFileExists(c1.cvFileKey)) && (await cvFileExists(c2.cvFileKey))).toBe(true);

    expect(await deleteJob(company.id, job.id)).toBe(true);

    expect(await jobRow(job.id)).toBeUndefined();
    expect(await db.select().from(candidates).where(eq(candidates.jobId, job.id))).toEqual([]);
    expect(await cvFileExists(c1.cvFileKey)).toBe(false);
    expect(await cvFileExists(c2.cvFileKey)).toBe(false);
    expect(await cvFileExists(kept.cvFileKey)).toBe(true);
    expect(await countJobCandidates(company.id, other.id)).toBe(1);
  });

  it("cannot delete another company's job or touch its files", async () => {
    const a = await makeCompany();
    const b = await makeCompany();
    const job = await createJob(a.company.id, parse());
    const c = await createCandidateFromCv({ job, source: "upload", cv: pdfCv() });

    expect(await deleteJob(b.company.id, job.id)).toBe(false);
    expect(await deleteJob(a.company.id, "missing-id")).toBe(false);
    expect(await countJobCandidates(b.company.id, job.id)).toBe(0);
    expect(await countJobCandidates(a.company.id, job.id)).toBe(1);
    expect(await cvFileExists(c.cvFileKey)).toBe(true);
  });
});
