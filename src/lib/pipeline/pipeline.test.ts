import { eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates, type Candidate } from "@/db/schema";
import type { CvAnalysis } from "@/lib/ai/schemas";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../test/factories";
import { processCandidate, recoverInterruptedCandidates, scheduleCandidateProcessing, waitForIdle } from "./index";

const ai = vi.hoisted(() => ({ model: null as unknown }));

vi.mock("@/lib/ai/providers", () => ({
  resolveProviderChain: () => ({
    chain: ai.model ? [{ id: "gemini", label: "Google Gemini", modelId: "gemini-test", model: ai.model }] : [],
    error: null,
  }),
}));

const CV_TEXT = [
  "Jane Doe",
  "jane@example.com | +44 7700 900123 | London",
  "Senior Backend Engineer with 7 years of Node.js, TypeScript and PostgreSQL experience at payments companies.",
].join("\n");

const analysis: CvAnalysis = {
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

let inFlight = 0;
let maxInFlight = 0;

function workingModel(delayMs = 0) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return {
        content: [{ type: "text", text: JSON.stringify(analysis) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

async function makeCandidate(opts: { text?: string; applicant?: { name: string; email: string; phone: string | null } } = {}) {
  const { company } = makeCompany();
  const job = makeJob(company.id);
  const cv = await validateCvUpload(new File([opts.text ?? CV_TEXT], "cv.txt", { type: "text/plain" }));
  return createCandidateFromCv({
    job,
    source: opts.applicant ? "public" : "upload",
    cv,
    applicant: opts.applicant,
  });
}

const reload = (id: string): Candidate => db.select().from(candidates).where(eq(candidates.id, id)).get()!;

beforeEach(() => {
  ai.model = workingModel();
  inFlight = 0;
  maxInFlight = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await waitForIdle();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("processCandidate", () => {
  it("extracts the CV, scores it and marks the candidate ready", async () => {
    const c = await makeCandidate();
    await processCandidate(c.id);

    const row = reload(c.id);
    expect(row.status).toBe("ready");
    expect(row.error).toBeNull();
    expect(row.score).toBe(82);
    expect(row.cvText).toBe(CV_TEXT);
    expect(row.profile?.fullName).toBe("Jane Doe");
    expect(row.evaluation?.recommendation).toBe("good_fit");
    expect(row.aiProvider).toBe("gemini");
    expect(row.aiModel).toBe("gemini-test");
    expect(row.processedAt).toBeInstanceOf(Date);
  });

  it("fills an uploaded candidate's contact details from the profile, lowercasing the email", async () => {
    const c = await makeCandidate();
    expect(c.name).toBeNull();
    await processCandidate(c.id);

    expect(reload(c.id)).toMatchObject({ name: "Jane Doe", email: "jane@example.com", phone: "+44 7700 900123" });
  });

  it("never overwrites what a public applicant typed, but fills fields they left empty", async () => {
    const c = await makeCandidate({ applicant: { name: "Janet Typed", email: "janet@typed.example", phone: null } });
    await processCandidate(c.id);

    expect(reload(c.id)).toMatchObject({
      status: "ready",
      name: "Janet Typed",
      email: "janet@typed.example",
      phone: "+44 7700 900123",
    });
  });

  it("fails with a friendly message when the CV has too little text", async () => {
    const model = workingModel();
    ai.model = model;
    const c = await makeCandidate({ text: "Jane Doe CV" });
    await processCandidate(c.id);

    const row = reload(c.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe(
      "We couldn't read any text from this CV. It may be a scanned image — upload a text-based PDF or Word file.",
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("records the AI failure on the row", async () => {
    ai.model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream overloaded");
      },
    });
    const c = await makeCandidate();
    await processCandidate(c.id);

    const row = reload(c.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("AI analysis failed (Google Gemini: upstream overloaded)");
    expect(row.score).toBeNull();
    // Extracted text is kept so a re-score doesn't need to re-parse the file.
    expect(row.cvText).toBe(CV_TEXT);
  });

  it("records a setup message when no AI provider is configured", async () => {
    ai.model = null;
    const c = await makeCandidate();
    await processCandidate(c.id);

    expect(reload(c.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/No AI provider is configured/) });
  });

  it("is a no-op for a candidate that isn't pending", async () => {
    const model = workingModel();
    ai.model = model;
    const c = await makeCandidate();
    await processCandidate(c.id);
    const before = reload(c.id);

    await processCandidate(c.id);

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(reload(c.id)).toEqual(before);
  });

  it("never throws, even for an unknown id", async () => {
    await expect(processCandidate("does-not-exist")).resolves.toBeUndefined();
  });
});

describe("scheduleCandidateProcessing", () => {
  it("returns immediately, processes in the background and dedupes ids", async () => {
    const model = workingModel(5);
    ai.model = model;
    const c = await makeCandidate();

    scheduleCandidateProcessing([c.id, c.id]);
    scheduleCandidateProcessing([c.id]);
    expect(reload(c.id).status).not.toBe("ready");

    await waitForIdle();
    expect(reload(c.id).status).toBe("ready");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("runs at most AI_CONCURRENCY (default 3) analyses at once", async () => {
    ai.model = workingModel(20);
    vi.stubEnv("AI_CONCURRENCY", "");
    const ids = await Promise.all(Array.from({ length: 6 }, () => makeCandidate().then((c) => c.id)));

    scheduleCandidateProcessing(ids);
    await waitForIdle();

    expect(ids.map((id) => reload(id).status)).toEqual(Array(6).fill("ready"));
    expect(maxInFlight).toBe(3);

    vi.stubEnv("AI_CONCURRENCY", "2");
    maxInFlight = 0;
    const more = await Promise.all(Array.from({ length: 4 }, () => makeCandidate().then((c) => c.id)));
    scheduleCandidateProcessing(more);
    await waitForIdle();
    expect(maxInFlight).toBe(2);
  });
});

describe("recoverInterruptedCandidates", () => {
  it("re-queues candidates left processing or pending by a previous process", async () => {
    const interrupted = await makeCandidate();
    const queued = await makeCandidate();
    db.update(candidates).set({ status: "processing" }).where(eq(candidates.id, interrupted.id)).run();

    await recoverInterruptedCandidates();
    await waitForIdle();

    expect(reload(interrupted.id).status).toBe("ready");
    expect(reload(queued.id).status).toBe("ready");
  });

  it("is safe when there is nothing to recover", async () => {
    db.delete(candidates).run();
    await expect(recoverInterruptedCandidates()).resolves.toBeUndefined();
    await waitForIdle();
  });
});
