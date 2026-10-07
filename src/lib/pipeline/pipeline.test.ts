import { eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates, jobs, type Candidate, type Job } from "@/db/schema";
import { getAiQuota } from "@/lib/ai/quota";
import type { CvAnalysis } from "@/lib/ai/schemas";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../test/factories";
import {
  processCandidate,
  recoverInterruptedCandidates,
  scheduleCandidateProcessing,
  startPendingRequeue,
  waitForIdle,
} from "./index";
import { rejectCvTextWrites } from "./test-helpers";

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

function modelResult(result: CvAnalysis = analysis) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function workingModel(delayMs = 0) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return modelResult();
    },
  });
}

/** The user message the model was sent. */
function promptText(prompt: Array<{ role: string; content: unknown }>): string {
  const user = prompt.find((m) => m.role === "user");
  return Array.isArray(user?.content) ? user.content.map((p: { text?: string }) => p.text ?? "").join("") : "";
}

async function makeCandidate(
  opts: { text?: string; job?: Job; applicant?: { name: string; email: string; phone: string | null } } = {},
) {
  const job = opts.job ?? (await makeJob((await makeCompany()).company.id));
  const cv = await validateCvUpload(new File([opts.text ?? CV_TEXT], "cv.txt", { type: "text/plain" }));
  return createCandidateFromCv({
    job,
    source: opts.applicant ? "public" : "upload",
    cv,
    applicant: opts.applicant,
  });
}

const reload = async (id: string): Promise<Candidate> => (await db.select().from(candidates).where(eq(candidates.id, id)))[0];
const setRow = async (id: string, values: Partial<Candidate>) => {
  await db.update(candidates).set(values).where(eq(candidates.id, id));
};

beforeEach(() => {
  ai.model = workingModel();
  inFlight = 0;
  maxInFlight = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await waitForIdle();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("processCandidate", () => {
  it("extracts the CV, scores it and marks the candidate ready", async () => {
    const c = await makeCandidate();
    await processCandidate(c.id);

    const row = await reload(c.id);
    expect(row.status).toBe("ready");
    expect(row.error).toBeNull();
    expect(row.score).toBe(82);
    expect(row.cvText).toBe(CV_TEXT);
    expect(row.profile?.fullName).toBe("Jane Doe");
    // Derived from the score (82), not the model's "good_fit".
    expect(row.evaluation?.recommendation).toBe("strong_fit");
    expect(row.aiProvider).toBe("gemini");
    expect(row.aiModel).toBe("gemini-test");
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(row.attempts).toBe(1);
  });

  it("fills an uploaded candidate's contact details from the profile, lowercasing the email", async () => {
    const c = await makeCandidate();
    expect(c.name).toBeNull();
    await processCandidate(c.id);

    expect(await reload(c.id)).toMatchObject({ name: "Jane Doe", email: "jane@example.com", phone: "+44 7700 900123" });
  });

  it("never overwrites what a public applicant typed, but fills fields they left empty", async () => {
    const c = await makeCandidate({ applicant: { name: "Janet Typed", email: "janet@typed.example", phone: null } });
    await processCandidate(c.id);

    expect(await reload(c.id)).toMatchObject({
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

    const row = await reload(c.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe(
      "We couldn't read any text from this CV. It may be a scanned image — upload a text-based PDF or Word file.",
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("stores at most 100,000 characters of CV text", async () => {
    const c = await makeCandidate({ text: `${CV_TEXT}\n${"Built payment APIs in Node.js. ".repeat(5000)}` });
    await processCandidate(c.id);

    const row = await reload(c.id);
    expect(row.status).toBe("ready");
    expect(row.cvText).toHaveLength(100_000);
  });

  it("records an employer-safe message when the AI fails", async () => {
    ai.model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream overloaded for key sk-proj-abcdefghijklmnop");
      },
    });
    const c = await makeCandidate();
    await processCandidate(c.id);

    const row = await reload(c.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The AI service couldn't analyze this CV right now. Try re-scoring it later.");
    expect(row.score).toBeNull();
    // Extracted text is kept so a re-score doesn't need to re-parse the file.
    expect(row.cvText).toBe(CV_TEXT);
  });

  it("leaves the candidate pending, without an error or an attempt, when no AI provider is configured", async () => {
    ai.model = null;
    const c = await makeCandidate();
    await processCandidate(c.id);

    expect(await reload(c.id)).toMatchObject({ status: "pending", error: null, attempts: 0, cvText: null });

    // Once a provider is configured (and the server restarts), recovery processes it.
    ai.model = workingModel();
    await recoverInterruptedCandidates();
    await waitForIdle();
    expect((await reload(c.id)).status).toBe("ready");
  });

  it("is a no-op for a candidate that isn't pending", async () => {
    const model = workingModel();
    ai.model = model;
    const c = await makeCandidate();
    await processCandidate(c.id);
    const before = await reload(c.id);

    await processCandidate(c.id);

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(await reload(c.id)).toEqual(before);
  });

  it("logs a database failure without the query's data (here, the CV text)", async () => {
    const errorLog = vi.mocked(console.error);
    const c = await makeCandidate({ text: `${CV_TEXT}\nSECRET-MARKER private reference` });
    const restore = await rejectCvTextWrites();
    try {
      await processCandidate(c.id);
    } finally {
      await restore();
    }

    expect(await reload(c.id)).toMatchObject({
      status: "failed",
      error: "Something went wrong while analyzing this CV. Try re-scoring it.",
    });
    const logged = errorLog.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("cv text rejected by test trigger");
    expect(logged).not.toContain("SECRET-MARKER");
  });

  it("never throws, even for an unknown id", async () => {
    await expect(processCandidate("does-not-exist")).resolves.toBeUndefined();
  });
});

describe("daily AI quota", () => {
  it("counts each analysis, and leaves a CV pending once the company's cap is reached until the next UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const model = workingModel();
    ai.model = model;
    const { company } = await makeCompany();
    const job = await makeJob(company.id);
    const first = await makeCandidate({ job, text: `${CV_TEXT}\nFirst` });
    const second = await makeCandidate({ job, text: `${CV_TEXT}\nSecond` });
    const otherCompany = await makeCandidate();

    await processCandidate(first.id);
    await processCandidate(second.id);
    await processCandidate(otherCompany.id);

    expect((await reload(first.id)).status).toBe("ready");
    expect(await reload(second.id)).toMatchObject({ status: "pending", error: null, attempts: 0 });
    expect((await reload(otherCompany.id)).status).toBe("ready");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(await getAiQuota(company.id)).toMatchObject({ used: 1, remaining: 0 });

    vi.setSystemTime(new Date("2026-10-08T00:00:01Z"));
    await processCandidate(second.id);
    expect(await reload(second.id)).toMatchObject({ status: "ready", attempts: 1 });
  });

  it("doesn't charge the cap for a CV that can't be read", async () => {
    ai.model = workingModel();
    const { company } = await makeCompany();
    const c = await makeCandidate({ job: await makeJob(company.id), text: "Jane Doe CV" });
    await processCandidate(c.id);

    expect((await reload(c.id)).status).toBe("failed");
    expect((await getAiQuota(company.id)).used).toBe(0);
  });
});

describe("re-score while processing", () => {
  it("discards the superseded run and re-runs against the current job", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => (firstStarted = r));
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (model.doGenerateCalls.length === 1) {
          firstStarted();
          await new Promise<void>((r) => (releaseFirst = r));
          return modelResult({ ...analysis, evaluation: { ...analysis.evaluation, overallScore: 30 } });
        }
        return modelResult({ ...analysis, evaluation: { ...analysis.evaluation, overallScore: 91 } });
      },
    });
    ai.model = model;
    const c = await makeCandidate();

    await scheduleCandidateProcessing([c.id]);
    await started;
    expect((await reload(c.id)).status).toBe("processing");

    // What markForRescore does, after the employer edited the job.
    await db.update(jobs).set({ title: "Staff Platform Engineer" }).where(eq(jobs.id, c.jobId));
    await setRow(c.id, { status: "pending", error: null, attempts: 0 });
    await scheduleCandidateProcessing([c.id]);

    releaseFirst();
    await waitForIdle();

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(promptText(model.doGenerateCalls[1].prompt)).toContain("Staff Platform Engineer");
    expect(await reload(c.id)).toMatchObject({ status: "ready", score: 91, attempts: 1 });
  });

  it("doesn't let a superseded run mark the candidate failed", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => (firstStarted = r));
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        firstStarted();
        await new Promise<void>((r) => (releaseFirst = r));
        throw new Error("upstream overloaded");
      },
    });
    ai.model = model;
    const c = await makeCandidate();

    const run = processCandidate(c.id);
    await started;
    await setRow(c.id, { status: "pending", error: null, attempts: 0 });
    releaseFirst();
    await run;

    expect(await reload(c.id)).toMatchObject({ status: "pending", error: null });
  });
});

describe("scheduleCandidateProcessing", () => {
  it("returns immediately, processes in the background and dedupes ids", async () => {
    const model = workingModel(5);
    ai.model = model;
    const c = await makeCandidate();

    await scheduleCandidateProcessing([c.id, c.id]);
    await scheduleCandidateProcessing([c.id]);
    expect((await reload(c.id)).status).not.toBe("ready");

    await waitForIdle();
    expect((await reload(c.id)).status).toBe("ready");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("runs at most AI_CONCURRENCY (default 3) analyses at once", async () => {
    ai.model = workingModel(50);
    vi.stubEnv("AI_CONCURRENCY", "");
    // Text already extracted (as for a re-score): child-process start-up jitter would otherwise keep the AI calls
    // from overlapping on a loaded machine, and this test is about the queue's limit.
    const withText = async () => {
      const c = await makeCandidate();
      await setRow(c.id, { cvText: CV_TEXT });
      return c.id;
    };
    const ids = await Promise.all(Array.from({ length: 6 }, withText));

    await scheduleCandidateProcessing(ids);
    await waitForIdle();

    expect(await Promise.all(ids.map(async (id) => (await reload(id)).status))).toEqual(Array(6).fill("ready"));
    expect(maxInFlight).toBe(3);

    vi.stubEnv("AI_CONCURRENCY", "2");
    maxInFlight = 0;
    const more = await Promise.all(Array.from({ length: 4 }, withText));
    await scheduleCandidateProcessing(more);
    await waitForIdle();
    expect(maxInFlight).toBe(2);
  });

  it("lets companies take turns, so one company's bulk upload doesn't hold up another's CV", async () => {
    vi.stubEnv("AI_CONCURRENCY", "1");
    const order: string[] = [];
    ai.model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        order.push(/Marker (\w+)/.exec(promptText(prompt))?.[1] ?? "?");
        return modelResult();
      },
    });
    const jobA = await makeJob((await makeCompany()).company.id);
    const jobB = await makeJob((await makeCompany()).company.id);
    const batchA = [];
    for (let i = 1; i <= 10; i++) batchA.push((await makeCandidate({ job: jobA, text: `${CV_TEXT}\nMarker A${i}` })).id);
    const b = await makeCandidate({ job: jobB, text: `${CV_TEXT}\nMarker B1` });

    await scheduleCandidateProcessing(batchA);
    await scheduleCandidateProcessing([b.id]);
    await waitForIdle();

    expect(order).toHaveLength(11);
    expect(order.indexOf("B1")).toBeLessThan(order.indexOf("A3"));
    expect(order.filter((m) => m.startsWith("A"))).toEqual(batchA.map((_, i) => `A${i + 1}`));
  });

  it("skips ids that no longer exist", async () => {
    const c = await makeCandidate();
    await expect(scheduleCandidateProcessing(["gone", c.id])).resolves.toBeUndefined();
    await waitForIdle();
    expect((await reload(c.id)).status).toBe("ready");
  });
});

describe("recoverInterruptedCandidates", () => {
  it("re-queues candidates left processing or pending by a previous process", async () => {
    const interrupted = await makeCandidate();
    const queued = await makeCandidate();
    await setRow(interrupted.id, { status: "processing", attempts: 2 });

    await recoverInterruptedCandidates();
    await waitForIdle();

    expect(await reload(interrupted.id)).toMatchObject({ status: "ready", attempts: 3 });
    expect((await reload(queued.id)).status).toBe("ready");
  });

  it("gives up on a CV that was mid-processing on each of its last 3 attempts, so it can't crash-loop the server", async () => {
    const model = workingModel();
    ai.model = model;
    const crashing = await makeCandidate();
    await setRow(crashing.id, { status: "processing", attempts: 3 });

    await recoverInterruptedCandidates();
    await waitForIdle();

    expect(await reload(crashing.id)).toMatchObject({
      status: "failed",
      error: "We couldn't process this CV. Try re-scoring it, or ask the candidate for a different file.",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("is safe when there is nothing to recover", async () => {
    await db.delete(candidates);
    await expect(recoverInterruptedCandidates()).resolves.toBeUndefined();
    await waitForIdle();
  });
});

describe("startPendingRequeue", () => {
  it("re-queues pending candidates every 5 minutes, not on start, and only starts one timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const c = await makeCandidate();
    const g = globalThis as unknown as { __cvPendingRequeueTimer?: ReturnType<typeof setInterval> };

    try {
      startPendingRequeue();
      startPendingRequeue();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      await waitForIdle();
      expect((await reload(c.id)).status).toBe("pending");

      vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      await waitForIdle();
      expect((await reload(c.id)).status).toBe("pending");

      vi.advanceTimersByTime(1);
      await waitForIdle();
      expect((await reload(c.id)).status).toBe("ready");
    } finally {
      clearInterval(g.__cvPendingRequeueTimer);
      delete g.__cvPendingRequeueTimer;
    }
  });
});
