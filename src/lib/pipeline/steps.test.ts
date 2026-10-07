import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAiQuota } from "@/lib/ai/quota";
import { deleteCvFile } from "@/lib/storage";
import { makeCompany, makeJob } from "../../../test/factories";
import {
  CV_TEXT,
  analysis,
  failingModel,
  makeCandidate,
  providerWith,
  reload,
  setRow,
  workingModel,
} from "./test-helpers";
import {
  GAVE_UP_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  UNREADABLE_CV_MESSAGE,
  analyzeStep,
  claimStep,
  extractStep,
  markFailed,
  runProcessCvSteps,
  type StepRunner,
} from "./steps";

const AI_FAILED_MESSAGE = "The AI service couldn't analyze this CV right now. Try re-scoring it later.";

/**
 * Runs each step inline like Inngest would, recording its id. Results go through JSON, as Inngest stores them,
 * so a step returning something that doesn't survive serialization breaks the run here too.
 */
function recordingSteps(before?: (id: string) => Promise<void>) {
  const ids: string[] = [];
  const step: StepRunner = {
    run: async (id, fn) => {
      ids.push(id);
      await before?.(id);
      const result = await fn();
      return JSON.parse(JSON.stringify(result)) as typeof result;
    },
  };
  return { ids, step };
}

const gemini = (model = workingModel()) => providerWith("gemini", model);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runProcessCvSteps", () => {
  it("claims, extracts, reserves quota, analyzes and saves, one step each", async () => {
    const model = workingModel();
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, step, [gemini(model)])).toBe("ready");

    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini", "save"]);
    expect(await reload(c.id)).toMatchObject({
      status: "ready",
      error: null,
      score: 82,
      cvText: CV_TEXT,
      aiProvider: "gemini",
      aiModel: "gemini-test",
      attempts: 1,
      // Filled from the profile for an uploaded CV, email lowercased.
      name: "Jane Doe",
      email: "jane@example.com",
    });
    // Derived from the score (82), not the model's "good_fit".
    expect((await reload(c.id)).evaluation?.recommendation).toBe("strong_fit");
    expect((await getAiQuota(c.companyId)).used).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("never overwrites what a public applicant typed", async () => {
    const c = await makeCandidate({ applicant: { name: "Janet Typed", email: "janet@typed.example", phone: null } });
    await runProcessCvSteps(c.id, recordingSteps().step, [gemini()]);
    expect(await reload(c.id)).toMatchObject({ name: "Janet Typed", email: "janet@typed.example", phone: "+44 7700 900123" });
  });

  it("skips extraction when the text is already stored (a re-score)", async () => {
    const c = await makeCandidate();
    await setRow(c.id, { cvText: `${CV_TEXT}\nStored earlier` });
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, step, [gemini()])).toBe("ready");
    expect(ids).toEqual(["claim", "reserve-quota", "analyze-gemini", "save"]);
    expect((await reload(c.id)).cvText).toBe(`${CV_TEXT}\nStored earlier`);
  });

  it("moves on to the next provider when one fails, in its own step, and records who answered", async () => {
    const broken = failingModel("quota exceeded");
    const working = workingModel();
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, step, [gemini(broken), providerWith("openai", working)])).toBe("ready");

    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini", "analyze-openai", "save"]);
    expect(broken.doGenerateCalls.length).toBeGreaterThan(0);
    expect(working.doGenerateCalls).toHaveLength(1);
    expect(await reload(c.id)).toMatchObject({ status: "ready", aiProvider: "openai", aiModel: "openai-test" });
    // One analysis, one charge, however many providers were tried.
    expect((await getAiQuota(c.companyId)).used).toBe(1);
  });

  it("saves model output containing NUL characters, which Postgres text and jsonb columns reject", async () => {
    const c = await makeCandidate();
    const nul = {
      ...analysis,
      profile: { ...analysis.profile, fullName: "Jane\u0000 Doe", skills: ["Node\u0000.js"] },
      evaluation: { ...analysis.evaluation, summary: "Strong\u0000 match." },
    };

    expect(await runProcessCvSteps(c.id, recordingSteps().step, [gemini(workingModel(nul))])).toBe("ready");
    const row = await reload(c.id);
    expect(row).toMatchObject({ status: "ready", name: "Jane Doe" });
    expect(row.profile?.skills).toEqual(["Node.js"]);
    expect(row.evaluation?.summary).toBe("Strong match.");
  });

  it("fails with the employer-safe message when every provider fails, keeping the extracted text", async () => {
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();
    const chain = [gemini(failingModel("bad key sk-proj-abcdefghijklmnop")), providerWith("groq", failingModel())];

    expect(await runProcessCvSteps(c.id, step, chain)).toBe("ai-failed");

    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini", "analyze-groq", "mark-failed"]);
    expect(await reload(c.id)).toMatchObject({ status: "failed", error: AI_FAILED_MESSAGE, score: null, cvText: CV_TEXT });
  });

  it("fails an unreadable CV without calling the AI or charging the cap", async () => {
    const model = workingModel();
    const c = await makeCandidate({ text: "Jane Doe CV" });
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, step, [gemini(model)])).toBe("unreadable");

    expect(ids).toEqual(["claim", "extract"]);
    expect(await reload(c.id)).toMatchObject({ status: "failed", error: UNREADABLE_CV_MESSAGE });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await getAiQuota(c.companyId)).used).toBe(0);
  });

  it("puts the CV back to pending, without counting the attempt, once the company's daily cap is used up", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const model = workingModel();
    const job = await makeJob((await makeCompany()).company.id);
    const first = await makeCandidate({ job, text: `${CV_TEXT}\nFirst` });
    const second = await makeCandidate({ job, text: `${CV_TEXT}\nSecond` });

    expect(await runProcessCvSteps(first.id, recordingSteps().step, [gemini(model)])).toBe("ready");
    const { ids, step } = recordingSteps();
    expect(await runProcessCvSteps(second.id, step, [gemini(model)])).toBe("quota-reached");

    expect(ids).toEqual(["claim", "extract", "reserve-quota"]);
    expect(await reload(second.id)).toMatchObject({ status: "pending", error: null, attempts: 0 });
    // The text is kept, so tomorrow's run goes straight to the AI.
    expect((await reload(second.id)).cvText).toContain("Second");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("doesn't claim anything when no AI provider is configured", async () => {
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, step, [])).toBe("no-provider");
    expect(ids).toEqual([]);
    expect(await reload(c.id)).toMatchObject({ status: "pending", attempts: 0, cvText: null, error: null });
  });

  it.each(["ready", "failed"] as const)("leaves a %s candidate alone", async (status) => {
    const model = workingModel();
    const c = await makeCandidate();
    await setRow(c.id, { status, attempts: 1 });
    const before = await reload(c.id);
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, step, [gemini(model)])).toBe("not-claimed");
    expect(ids).toEqual(["claim"]);
    expect(await reload(c.id)).toEqual(before);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("is a no-op for a candidate that no longer exists", async () => {
    expect(await runProcessCvSteps(crypto.randomUUID(), recordingSteps().step, [gemini()])).toBe("not-claimed");
  });

  it("takes over a CV left processing by a cancelled run, counting the attempt", async () => {
    const c = await makeCandidate();
    await setRow(c.id, { status: "processing", attempts: 1 });

    expect(await runProcessCvSteps(c.id, recordingSteps().step, [gemini()])).toBe("ready");
    expect(await reload(c.id)).toMatchObject({ status: "ready", attempts: 2 });
  });

  it("gives up on a CV whose last 3 runs were all cut off, so it can't loop forever", async () => {
    const model = workingModel();
    const c = await makeCandidate();
    await setRow(c.id, { status: "processing", attempts: 3 });
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, step, [gemini(model)])).toBe("gave-up");
    expect(ids).toEqual(["claim"]);
    expect(await reload(c.id)).toMatchObject({ status: "failed", error: GAVE_UP_MESSAGE, attempts: 4 });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("discards the result when the CV was re-scored while it was being analyzed", async () => {
    const c = await makeCandidate();
    // What markForRescore does, landing between the AI answer and the save.
    const { step } = recordingSteps(async (id) => {
      if (id === "save") await setRow(c.id, { status: "pending", error: null, attempts: 0 });
    });

    expect(await runProcessCvSteps(c.id, step, [gemini()])).toBe("superseded");
    expect(await reload(c.id)).toMatchObject({ status: "pending", score: null, profile: null, attempts: 0 });
  });

  it("stops before calling the AI when the CV was re-scored after the quota step", async () => {
    const model = workingModel();
    const c = await makeCandidate();
    const { ids, step } = recordingSteps(async (id) => {
      if (id === "analyze-gemini") await setRow(c.id, { status: "pending", attempts: 0 });
    });

    expect(await runProcessCvSteps(c.id, step, [gemini(model)])).toBe("superseded");
    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini"]);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await reload(c.id)).status).toBe("pending");
  });

  it("doesn't let a superseded run mark the CV failed", async () => {
    const c = await makeCandidate();
    const { step } = recordingSteps(async (id) => {
      if (id === "mark-failed") await setRow(c.id, { status: "pending", attempts: 0 });
    });

    expect(await runProcessCvSteps(c.id, step, [gemini(failingModel())])).toBe("superseded");
    expect(await reload(c.id)).toMatchObject({ status: "pending", error: null });
  });
});

describe("extractStep", () => {
  it("throws on a storage error, so the step is retried rather than the CV failed as unreadable", async () => {
    const c = await makeCandidate();
    await claimStep(c.id);
    await deleteCvFile(c.cvFileKey);

    await expect(extractStep(c.id)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await reload(c.id)).toMatchObject({ status: "processing", error: null });
  });

  it("stores at most 100,000 characters of CV text", async () => {
    const c = await makeCandidate({ text: `${CV_TEXT}\n${"Built payment APIs in Node.js. ".repeat(5000)}` });
    await claimStep(c.id);
    expect(await extractStep(c.id)).toBe("ok");
    expect((await reload(c.id)).cvText).toHaveLength(100_000);
  });
});

describe("analyzeStep", () => {
  it("returns a provider failure instead of throwing, with a redacted reason", async () => {
    const c = await makeCandidate();
    await claimStep(c.id);
    await extractStep(c.id);

    const result = await analyzeStep(c.id, gemini(failingModel("bad key sk-proj-abcdefghijklmnop")));
    expect(result).toEqual({ status: "failed", reason: "bad key [redacted]" });
  });

  it("gives up on a provider after the step's timeout", async () => {
    const c = await makeCandidate();
    await claimStep(c.id);
    await extractStep(c.id);
    const hanging = providerWith(
      "anthropic",
      new MockLanguageModelV4({
        doGenerate: ({ abortSignal }) =>
          new Promise((_, reject) => abortSignal?.addEventListener("abort", () => reject(abortSignal.reason))),
      }),
    );

    expect(await analyzeStep(c.id, hanging, { timeoutMs: 50 })).toEqual({ status: "failed", reason: "timed out after 0.05s" });
  });

  it("returns a result that survives JSON serialization unchanged", async () => {
    const c = await makeCandidate();
    await claimStep(c.id);
    await extractStep(c.id);
    const result = await analyzeStep(c.id, gemini());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).toMatchObject({ status: "ok", result: { provider: "gemini", analysis: { profile: { fullName: "Jane Doe" } } } });
  });
});

describe("markFailed (process-cv onFailure)", () => {
  it("fails a CV that is still processing, and leaves one that moved on alone", async () => {
    const stuck = await makeCandidate();
    const done = await makeCandidate();
    await setRow(stuck.id, { status: "processing" });
    await setRow(done.id, { status: "ready" });

    expect(await markFailed(stuck.id, GENERIC_FAILURE_MESSAGE)).toBe(true);
    expect(await markFailed(done.id, GENERIC_FAILURE_MESSAGE)).toBe(false);
    expect(await reload(stuck.id)).toMatchObject({ status: "failed", error: GENERIC_FAILURE_MESSAGE });
    expect((await reload(done.id)).status).toBe("ready");
  });
});
