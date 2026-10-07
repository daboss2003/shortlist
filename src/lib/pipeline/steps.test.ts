import { eq } from "drizzle-orm";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { getAiQuota } from "@/lib/ai/quota";
import { deleteCvFile } from "@/lib/storage";
import { makeCompany, makeJob } from "../../../test/factories";
import {
  CV_TEXT,
  analysis,
  failingModel,
  makeCandidate,
  modelResult,
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
  reserveQuotaStep,
  runProcessCvSteps,
  saveCvText,
  type StepRunner,
} from "./steps";

const AI_FAILED_MESSAGE = "The AI service couldn't analyze this CV right now. Try re-scoring it later.";
/** The claim token of the run under test (in production, its Inngest run id). */
const RUN = "run-1";

/**
 * Runs each step inline like Inngest would, recording its id and result. Results go through JSON, as Inngest stores
 * them, so a step returning something that doesn't survive serialization breaks the run here too.
 */
function recordingSteps(before?: (id: string) => Promise<void>) {
  const ids: string[] = [];
  const results: Array<{ id: string; json: string }> = [];
  const step: StepRunner = {
    run: async (id, fn) => {
      ids.push(id);
      await before?.(id);
      const json = JSON.stringify(await fn());
      results.push({ id, json });
      return JSON.parse(json) as never;
    },
  };
  return { ids, results, step };
}

const gemini = (model = workingModel()) => providerWith("gemini", model);

/** A claimed CV with its text extracted, as the reserve-quota step finds it. */
async function claimedWithText(opts: Parameters<typeof makeCandidate>[0] = {}, token = RUN) {
  const c = await makeCandidate(opts);
  await claimStep(c.id, token);
  expect(await extractStep(c.id, token)).toBe("ok");
  return c;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runProcessCvSteps", () => {
  it("claims, extracts, reserves quota, then analyzes and saves in one step", async () => {
    const model = workingModel();
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini(model)])).toBe("ready");

    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini"]);
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

  it("records the claim: its token and when it was made", async () => {
    const c = await makeCandidate();
    const before = Date.now();
    await claimStep(c.id, RUN);

    const row = await reload(c.id);
    expect(row).toMatchObject({ status: "processing", claimToken: RUN, attempts: 1 });
    expect(row.claimedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("never overwrites what a public applicant typed", async () => {
    const c = await makeCandidate({ applicant: { name: "Janet Typed", email: "janet@typed.example", phone: null } });
    await runProcessCvSteps(c.id, RUN, recordingSteps().step, [gemini()]);
    expect(await reload(c.id)).toMatchObject({ name: "Janet Typed", email: "janet@typed.example", phone: "+44 7700 900123" });
  });

  it("skips extraction when the text is already stored (a re-score)", async () => {
    const c = await makeCandidate();
    await setRow(c.id, { cvText: `${CV_TEXT}\nStored earlier` });
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini()])).toBe("ready");
    expect(ids).toEqual(["claim", "reserve-quota", "analyze-gemini"]);
    expect((await reload(c.id)).cvText).toBe(`${CV_TEXT}\nStored earlier`);
  });

  it("moves on to the next provider when one fails, in its own step, and records who answered", async () => {
    const broken = failingModel("quota exceeded");
    const working = workingModel();
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini(broken), providerWith("openai", working)])).toBe("ready");

    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini", "analyze-openai"]);
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

    expect(await runProcessCvSteps(c.id, RUN, recordingSteps().step, [gemini(workingModel(nul))])).toBe("ready");
    const row = await reload(c.id);
    expect(row).toMatchObject({ status: "ready", name: "Jane Doe" });
    expect(row.profile?.skills).toEqual(["Node.js"]);
    expect(row.evaluation?.summary).toBe("Strong match.");
  });

  it("fails with the employer-safe message when every provider fails, keeping the extracted text", async () => {
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();
    const chain = [gemini(failingModel("bad key sk-proj-abcdefghijklmnop")), providerWith("groq", failingModel())];

    expect(await runProcessCvSteps(c.id, RUN, step, chain)).toBe("ai-failed");

    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini", "analyze-groq", "mark-failed"]);
    expect(await reload(c.id)).toMatchObject({ status: "failed", error: AI_FAILED_MESSAGE, score: null, cvText: CV_TEXT });
  });

  it("fails an unreadable CV without calling the AI or charging the cap", async () => {
    const model = workingModel();
    const c = await makeCandidate({ text: "Jane Doe CV" });
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini(model)])).toBe("unreadable");

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

    expect(await runProcessCvSteps(first.id, "run-a", recordingSteps().step, [gemini(model)])).toBe("ready");
    const { ids, step } = recordingSteps();
    expect(await runProcessCvSteps(second.id, "run-b", step, [gemini(model)])).toBe("quota-reached");

    expect(ids).toEqual(["claim", "extract", "reserve-quota"]);
    expect(await reload(second.id)).toMatchObject({ status: "pending", error: null, attempts: 0 });
    // The text is kept, so tomorrow's run goes straight to the AI.
    expect((await reload(second.id)).cvText).toContain("Second");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect((await getAiQuota(job.companyId)).used).toBe(1);
  });

  it("doesn't claim anything when no AI provider is configured", async () => {
    const c = await makeCandidate();
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, RUN, step, [])).toBe("no-provider");
    expect(ids).toEqual([]);
    expect(await reload(c.id)).toMatchObject({ status: "pending", attempts: 0, cvText: null, error: null, claimToken: null });
  });

  it.each(["ready", "failed"] as const)("leaves a %s candidate alone", async (status) => {
    const model = workingModel();
    const c = await makeCandidate();
    await setRow(c.id, { status, attempts: 1 });
    const before = await reload(c.id);
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini(model)])).toBe("not-claimed");
    expect(ids).toEqual(["claim"]);
    expect(await reload(c.id)).toEqual(before);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("is a no-op for a candidate that no longer exists", async () => {
    expect(await runProcessCvSteps(crypto.randomUUID(), RUN, recordingSteps().step, [gemini()])).toBe("not-claimed");
  });

  it("takes over a CV left processing by another run (cancelled, or stuck since an outage), counting the attempt", async () => {
    const c = await makeCandidate();
    const stuckSince = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await setRow(c.id, { status: "processing", attempts: 1, claimToken: "run-0", claimedAt: stuckSince });

    expect(await runProcessCvSteps(c.id, RUN, recordingSteps().step, [gemini()])).toBe("ready");
    const row = await reload(c.id);
    expect(row).toMatchObject({ status: "ready", attempts: 2 });
    expect(row.claimToken).toContain(RUN);
    expect(row.claimedAt!.getTime()).toBeGreaterThan(stuckSince.getTime());
  });

  it("gives up on a CV whose last 3 runs were all cut off, so it can't loop forever", async () => {
    const model = workingModel();
    const c = await makeCandidate();
    await setRow(c.id, { status: "processing", attempts: 3, claimToken: "run-0" });
    const { ids, step } = recordingSteps();

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini(model)])).toBe("gave-up");
    expect(ids).toEqual(["claim"]);
    expect(await reload(c.id)).toMatchObject({ status: "failed", error: GAVE_UP_MESSAGE, attempts: 4 });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("discards the result when the CV was re-scored while it was being analyzed", async () => {
    const c = await makeCandidate();
    // What markForRescore does, landing between the AI's answer and the save.
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await setRow(c.id, { status: "pending", error: null, attempts: 0 });
        return modelResult();
      },
    });

    expect(await runProcessCvSteps(c.id, RUN, recordingSteps().step, [gemini(model)])).toBe("superseded");
    expect(await reload(c.id)).toMatchObject({ status: "pending", score: null, profile: null, attempts: 0 });
  });

  it("stops before calling the AI when the CV was re-scored after the quota step", async () => {
    const model = workingModel();
    const c = await makeCandidate();
    const { ids, step } = recordingSteps(async (id) => {
      if (id === "analyze-gemini") await setRow(c.id, { status: "pending", attempts: 0 });
    });

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini(model)])).toBe("superseded");
    expect(ids).toEqual(["claim", "extract", "reserve-quota", "analyze-gemini"]);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await reload(c.id)).status).toBe("pending");
  });

  it("doesn't let a superseded run mark the CV failed", async () => {
    const c = await makeCandidate();
    const { step } = recordingSteps(async (id) => {
      if (id === "mark-failed") await setRow(c.id, { status: "pending", attempts: 0 });
    });

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini(failingModel())])).toBe("superseded");
    expect(await reload(c.id)).toMatchObject({ status: "pending", error: null });
  });

  it("charges once when the reserve-quota step is retried after its response was lost", async () => {
    const c = await makeCandidate();
    let lost = false;
    const step: StepRunner = {
      run: async (id, fn) => {
        // Inngest retries a step whose result never arrived: the work ran, its answer is lost, and it runs again.
        if (id === "reserve-quota" && !lost) {
          lost = true;
          await fn();
        }
        return fn();
      },
    };

    expect(await runProcessCvSteps(c.id, RUN, step, [gemini()])).toBe("ready");
    expect(lost).toBe(true);
    expect((await getAiQuota(c.companyId)).used).toBe(1);
  });
});

describe("what Inngest stores", () => {
  /** Every string of the analysis and the CV text (long enough to mean something), and every field name. */
  function personalData() {
    const values = new Set<string>([...CV_TEXT.split("\n"), "Jane Doe", "jane@example.com"]);
    const keys = new Set<string>(["profile", "evaluation", "cvText", "analysis"]);
    const walk = (value: unknown) => {
      if (typeof value === "string" && value.length >= 4) values.add(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(analysis);
    return { values: [...values], keys: [...keys] };
  }

  function expectNoPersonalData(results: Array<{ id: string; json: string }>) {
    const { values, keys } = personalData();
    expect(results.length).toBeGreaterThan(0);
    for (const { id, json } of results) {
      for (const key of keys) expect(json, `step ${id} returned the field "${key}"`).not.toContain(`"${key}"`);
      for (const value of values) expect(json, `step ${id} returned "${value}"`).not.toContain(value);
    }
  }

  it("never gets the profile, evaluation, CV text or contact details as a step result", async () => {
    // A provider error quoting the CV, as some do with the prompt: only a code may come back.
    const quoting = failingModel(`content rejected near "${CV_TEXT.split("\n")[1]}"`);
    const success = recordingSteps();
    const c = await makeCandidate();
    expect(await runProcessCvSteps(c.id, RUN, success.step, [gemini(quoting), providerWith("openai", workingModel())])).toBe(
      "ready",
    );
    expect(success.results.find((r) => r.id === "analyze-gemini")?.json).toBe('{"ok":false,"reason":"provider-error"}');
    expect(success.results.find((r) => r.id === "analyze-openai")?.json).toBe('{"ok":true}');

    const failure = recordingSteps();
    expect(await runProcessCvSteps((await makeCandidate()).id, RUN, failure.step, [gemini(quoting)])).toBe("ai-failed");

    // The checks themselves catch personal data: the analysis as a result would fail them.
    expect(() => expectNoPersonalData([{ id: "probe", json: JSON.stringify(analysis.profile.skills) }])).toThrow();
    expectNoPersonalData([...success.results, ...failure.results]);
  });
});

describe("claim ownership", () => {
  it("doesn't let an older run's late writes touch the row a newer run has claimed", async () => {
    const model = workingModel();
    const c = await claimedWithText({}, "run-1");
    // A re-score or re-queue starts run 2, which cancels run 1 and takes the row over.
    expect(await claimStep(c.id, "run-2")).toEqual({ claimed: true, needsText: false });

    // Run 1's in-flight steps land late: nothing is written, charged or analyzed.
    expect(await saveCvText(c.id, "run-1", "stale text")).toBe(false);
    expect(await reserveQuotaStep(c.id, "run-1")).toBe("superseded");
    expect(await analyzeStep(c.id, "run-1", gemini(model))).toEqual({ ok: false, reason: "superseded" });
    expect(await markFailed(c.id, "run-1", GENERIC_FAILURE_MESSAGE)).toBe(false);
    expect(await reload(c.id)).toMatchObject({ status: "processing", claimToken: "run-2", cvText: CV_TEXT, error: null });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await getAiQuota(c.companyId)).used).toBe(0);

    // Run 2 carries on as normal.
    expect(await reserveQuotaStep(c.id, "run-2")).toBe("reserved");
    expect(await analyzeStep(c.id, "run-2", gemini(model))).toEqual({ ok: true });
    expect(await reload(c.id)).toMatchObject({ status: "ready", score: 82 });
  });

  it("doesn't let an older run overwrite a newer run's finished result", async () => {
    const c = await claimedWithText({}, "run-1");
    await claimStep(c.id, "run-2");
    await reserveQuotaStep(c.id, "run-2");
    expect(await analyzeStep(c.id, "run-2", gemini())).toEqual({ ok: true });
    // The newer run finished; the row is no longer processing at all.
    expect(await markFailed(c.id, "run-2", GENERIC_FAILURE_MESSAGE)).toBe(false);
    expect(await markFailed(c.id, "run-1", GENERIC_FAILURE_MESSAGE)).toBe(false);
    expect((await reload(c.id)).status).toBe("ready");
  });
});

describe("reserveQuotaStep", () => {
  it("charges a claim once, however often the step is retried", async () => {
    const c = await claimedWithText();

    expect(await reserveQuotaStep(c.id, RUN)).toBe("reserved");
    expect(await reserveQuotaStep(c.id, RUN)).toBe("reserved");
    expect(await reserveQuotaStep(c.id, RUN)).toBe("reserved");

    expect((await getAiQuota(c.companyId)).used).toBe(1);
    // The charge doesn't loosen the claim: the run's later writes still land.
    expect(await analyzeStep(c.id, RUN, gemini())).toEqual({ ok: true });
    expect((await reload(c.id)).status).toBe("ready");
  });

  it("charges each new claim of the same CV again (a re-score is a new analysis)", async () => {
    const c = await claimedWithText({}, "run-1");
    expect(await reserveQuotaStep(c.id, "run-1")).toBe("reserved");
    await claimStep(c.id, "run-2");
    expect(await reserveQuotaStep(c.id, "run-2")).toBe("reserved");
    expect((await getAiQuota(c.companyId)).used).toBe(2);
  });

  it("charges nothing for a deleted candidate", async () => {
    const c = await claimedWithText();
    await db.delete(candidates).where(eq(candidates.id, c.id));

    expect(await reserveQuotaStep(c.id, RUN)).toBe("superseded");
    expect((await getAiQuota(c.companyId)).used).toBe(0);
  });

  it("charges nothing for a CV re-scored since its claim", async () => {
    const c = await claimedWithText();
    await setRow(c.id, { status: "pending", error: null, attempts: 0 });

    expect(await reserveQuotaStep(c.id, RUN)).toBe("superseded");
    expect((await getAiQuota(c.companyId)).used).toBe(0);
    expect((await reload(c.id)).status).toBe("pending");
  });

  it("hands out exactly the remaining slots to concurrent claims of one company", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "3");
    const job = await makeJob((await makeCompany()).company.id);
    const claimed = [];
    for (let i = 0; i < 8; i++) claimed.push(await claimedWithText({ job, text: `${CV_TEXT}\n${i}` }, `run-${i}`));

    const results = await Promise.all(claimed.map((c, i) => reserveQuotaStep(c.id, `run-${i}`)));

    expect(results.filter((r) => r === "reserved")).toHaveLength(3);
    expect(results.filter((r) => r === "quota-reached")).toHaveLength(5);
    expect(await getAiQuota(job.companyId)).toMatchObject({ used: 3, remaining: 0 });
    const statuses = await Promise.all(claimed.map(async (c) => (await reload(c.id)).status));
    expect(statuses.filter((s) => s === "pending")).toHaveLength(5);
  });
});

describe("extractStep", () => {
  it("throws on a storage error, so the step is retried rather than the CV failed as unreadable", async () => {
    const c = await makeCandidate();
    await claimStep(c.id, RUN);
    await deleteCvFile(c.cvFileKey);

    await expect(extractStep(c.id, RUN)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await reload(c.id)).toMatchObject({ status: "processing", error: null });
  });

  it("stores at most 100,000 characters of CV text", async () => {
    const c = await makeCandidate({ text: `${CV_TEXT}\n${"Built payment APIs in Node.js. ".repeat(5000)}` });
    await claimStep(c.id, RUN);
    expect(await extractStep(c.id, RUN)).toBe("ok");
    expect((await reload(c.id)).cvText).toHaveLength(100_000);
  });
});

describe("analyzeStep", () => {
  it("returns a provider failure as a short code instead of throwing", async () => {
    const c = await claimedWithText();
    await reserveQuotaStep(c.id, RUN);

    const result = await analyzeStep(c.id, RUN, gemini(failingModel("bad key sk-proj-abcdefghijklmnop")));
    expect(result).toEqual({ ok: false, reason: "provider-error" });
    expect((await reload(c.id)).status).toBe("processing");
  });

  it("reports a provider's HTTP status", async () => {
    const c = await claimedWithText();
    const limited = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "Too many requests for Jane Doe's CV",
          url: "https://api.example.com/v1/generate",
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: false,
        });
      },
    });

    expect(await analyzeStep(c.id, RUN, gemini(limited))).toEqual({ ok: false, reason: "http-429" });
  });

  it("gives up on a provider after the step's timeout", async () => {
    const c = await claimedWithText();
    const hanging = providerWith(
      "anthropic",
      new MockLanguageModelV4({
        doGenerate: ({ abortSignal }) =>
          new Promise((_, reject) => abortSignal?.addEventListener("abort", () => reject(abortSignal.reason))),
      }),
    );

    expect(await analyzeStep(c.id, RUN, hanging, { timeoutMs: 50 })).toEqual({ ok: false, reason: "timeout" });
  });

  it("saves the analysis itself and returns only that it did", async () => {
    const c = await claimedWithText();
    expect(await analyzeStep(c.id, RUN, gemini())).toEqual({ ok: true });
    expect(await reload(c.id)).toMatchObject({ status: "ready", score: 82, aiProvider: "gemini" });
  });
});

describe("markFailed (process-cv onFailure)", () => {
  it("fails a CV still processing under the run's claim, and leaves one that moved on alone", async () => {
    const stuck = await makeCandidate();
    const done = await makeCandidate();
    await claimStep(stuck.id, RUN);
    await claimStep(done.id, RUN);
    await setRow(done.id, { status: "ready" });

    expect(await markFailed(stuck.id, RUN, GENERIC_FAILURE_MESSAGE)).toBe(true);
    expect(await markFailed(done.id, RUN, GENERIC_FAILURE_MESSAGE)).toBe(false);
    expect(await reload(stuck.id)).toMatchObject({ status: "failed", error: GENERIC_FAILURE_MESSAGE });
    expect((await reload(done.id)).status).toBe("ready");
  });
});
