import { eq, sql } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { db } from "@/db";
import { candidates, type Candidate, type Job } from "@/db/schema";
import type { ResolvedProvider } from "@/lib/ai/providers";
import type { CvAnalysis } from "@/lib/ai/schemas";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../test/factories";

// Test-only fixtures for the pipeline tests (never imported by app code).

export const CV_TEXT = [
  "Jane Doe",
  "jane@example.com | +44 7700 900123 | London",
  "Senior Backend Engineer with 7 years of Node.js, TypeScript and PostgreSQL experience at payments companies.",
].join("\n");

export const analysis: CvAnalysis = {
  profile: {
    fullName: "Jane Doe",
    email: "Jane@Example.COM",
    phone: "+44 7700 900123",
    location: "London",
    headline: "Senior Backend Engineer",
    summary: "Backend engineer focused on payments.",
    totalExperienceYears: 7,
    skills: ["Node.js", "TypeScript", "PostgreSQL"],
    experience: [{ title: "Senior Engineer", company: "PayCo", startDate: "2019-01", endDate: "Present", description: null }],
    education: [],
    certifications: [],
    languages: ["English"],
    links: [],
  },
  evaluation: {
    overallScore: 82,
    skillsScore: 85,
    experienceScore: 88,
    educationScore: 60,
    matchedSkills: ["Node.js", "TypeScript", "PostgreSQL"],
    missingSkills: ["AWS"],
    strengths: ["7 years of Node.js on payments APIs"],
    concerns: ["No AWS experience mentioned"],
    summary: "Strong backend match missing AWS.",
    recommendation: "good_fit",
  },
};

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

export function modelResult(result: CvAnalysis = analysis) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

export const workingModel = (result: CvAnalysis = analysis) =>
  new MockLanguageModelV4({ doGenerate: async () => modelResult(result) });

export const failingModel = (message = "upstream overloaded") =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error(message);
    },
  });

export const providerWith = (id: ResolvedProvider["id"], model: MockLanguageModelV4): ResolvedProvider => ({
  id,
  label: id,
  modelId: `${id}-test`,
  model,
});

export async function makeCandidate(
  opts: { text?: string; job?: Job; applicant?: { name: string; email: string; phone: string | null } } = {},
): Promise<Candidate> {
  const job = opts.job ?? (await makeJob((await makeCompany()).company.id));
  const cv = await validateCvUpload(new File([opts.text ?? CV_TEXT], "cv.txt", { type: "text/plain" }));
  return createCandidateFromCv({ job, source: opts.applicant ? "public" : "upload", cv, applicant: opts.applicant });
}

export const reload = async (id: string): Promise<Candidate> =>
  (await db.select().from(candidates).where(eq(candidates.id, id)))[0];

export async function setRow(id: string, values: Partial<Candidate>): Promise<void> {
  await db.update(candidates).set(values).where(eq(candidates.id, id));
}

/**
 * Makes the database reject every write of candidates.cv_text until the returned cleanup runs, so a query whose
 * parameters hold the CV text fails for real.
 */
export async function rejectCvTextWrites(): Promise<() => Promise<void>> {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION reject_cv_text() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'cv text rejected by test trigger'; END $$ LANGUAGE plpgsql`),
  );
  await db.execute(
    sql.raw("CREATE TRIGGER reject_cv_text BEFORE UPDATE OF cv_text ON candidates FOR EACH ROW EXECUTE FUNCTION reject_cv_text()"),
  );
  return async () => {
    await db.execute(sql.raw("DROP TRIGGER reject_cv_text ON candidates"));
  };
}
