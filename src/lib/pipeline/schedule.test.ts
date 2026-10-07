import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { aiUsage, candidates, type Job } from "@/db/schema";
import { makeCompany, makeJob } from "../../../test/factories";
import {
  findRequeueCandidates,
  processEventId,
  requeuePendingCandidates,
  scheduleCandidateProcessing,
  waitForIdle,
} from "./index";
import { executionMode } from "./runtime";
import { claimStep, runProcessCvSteps, type StepRunner } from "./steps";
import { CV_TEXT, busyModel, makeCandidate, providerWith, reload, setRow, workingModel } from "./test-helpers";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(rows: Array<{ id: string; companyId: string; eventId: string }>) => Promise<void>>(),
  model: null as unknown,
}));

vi.mock("@/inngest/client", () => ({ sendCvProcessRequested: mocks.send }));
vi.mock("@/lib/ai/providers", () => ({
  resolveProviderChain: () => ({
    chain: mocks.model ? [{ id: "gemini", label: "Google Gemini", modelId: "gemini-test", model: mocks.model }] : [],
    error: null,
  }),
}));

const NOW = new Date("2026-10-07T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const sentIds = () => mocks.send.mock.calls.flatMap(([rows]) => rows.map((r) => r.id));
const sentEventIds = () => mocks.send.mock.calls.flatMap(([rows]) => rows.map((r) => r.eventId));
const inline: StepRunner = { run: (_id, fn) => fn() };

/** A CV left "processing" by a run claimed `ageMinutes` before NOW (null: claimed before claims were timed). */
async function processingCandidate(job: Job, ageMinutes: number | null, claimToken: string | null = "run-0") {
  const c = await makeCandidate({ job, text: `${CV_TEXT}\n${crypto.randomUUID()}` });
  await setRow(c.id, {
    createdAt: minutesAgo(120),
    status: "processing",
    attempts: 1,
    claimToken,
    claimedAt: ageMinutes == null ? null : minutesAgo(ageMinutes),
  });
  return c;
}

/** A pending candidate created `ageMinutes` before NOW. */
async function pendingCandidate(job: Job, ageMinutes: number) {
  const c = await makeCandidate({ job, text: `${CV_TEXT}\n${crypto.randomUUID()}` });
  await setRow(c.id, { createdAt: minutesAgo(ageMinutes) });
  return c;
}

async function usedToday(companyId: string, analyses: number, day: Date = NOW) {
  await db.insert(aiUsage).values({ companyId, day: day.toISOString().slice(0, 10), analyses });
}

beforeEach(async () => {
  mocks.model = workingModel();
  mocks.send.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Each test sees only its own candidates.
  await db.delete(candidates);
});

afterEach(async () => {
  await waitForIdle();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("executionMode", () => {
  it("uses Inngest when it is configured, after() on Netlify without it, and the in-process queue otherwise", () => {
    expect(executionMode()).toBe("in-process");
    vi.stubEnv("NETLIFY", "true");
    expect(executionMode()).toBe("netlify-after");
    vi.stubEnv("INNGEST_EVENT_KEY", "evt-key");
    expect(executionMode()).toBe("inngest");
    vi.stubEnv("INNGEST_EVENT_KEY", "");
    vi.stubEnv("NETLIFY", "");
    vi.stubEnv("INNGEST_DEV", "1");
    expect(executionMode()).toBe("inngest");
    vi.stubEnv("INNGEST_DEV", "0");
    expect(executionMode()).toBe("in-process");
  });
});

describe("scheduleCandidateProcessing with Inngest", () => {
  beforeEach(() => {
    vi.stubEnv("INNGEST_EVENT_KEY", "evt-key");
  });

  it("sends one event per candidate with its company, deduped, in the caller's order, skipping deleted ids", async () => {
    const a = await makeCandidate();
    const b = await makeCandidate();

    await scheduleCandidateProcessing([b.id, "gone", a.id, b.id]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0]).toEqual([
      { id: b.id, companyId: b.companyId, eventId: `cv-${b.id}-new` },
      { id: a.id, companyId: a.companyId, eventId: `cv-${a.id}-new` },
    ]);
    // Nothing runs in this process.
    await waitForIdle();
    expect((await reload(a.id)).status).toBe("pending");
  });

  it("sends no more CVs per company than its remaining AI allowance today; the rest stay pending", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "3");
    const partly = await makeJob((await makeCompany()).company.id);
    const capped = await makeJob((await makeCompany()).company.id);
    const fresh = await makeJob((await makeCompany()).company.id);
    await usedToday(partly.companyId, 2, new Date());
    await usedToday(capped.companyId, 3, new Date());
    const partlyCvs = [await pendingCandidate(partly, 0), await pendingCandidate(partly, 0)];
    const cappedCv = await pendingCandidate(capped, 0);
    const freshCvs = [await pendingCandidate(fresh, 0), await pendingCandidate(fresh, 0)];

    await scheduleCandidateProcessing([...partlyCvs, cappedCv, ...freshCvs].map((c) => c.id));

    // 1 slot left: only the first; none for the capped company; both for the fresh one.
    expect(sentIds()).toEqual([partlyCvs[0].id, ...freshCvs.map((c) => c.id)]);
    expect((await reload(partlyCvs[1].id)).status).toBe("pending");
    expect((await reload(cappedCv.id)).status).toBe("pending");
  });

  it("sends nothing for a company that has used today's cap", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const job = await makeJob((await makeCompany()).company.id);
    await usedToday(job.companyId, 1, new Date());

    await scheduleCandidateProcessing([(await makeCandidate({ job })).id]);
    expect(sentIds()).toEqual([]);
  });

  it("sends every CV when the cap is off", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "0");
    const job = await makeJob((await makeCompany()).company.id);
    await usedToday(job.companyId, 10_000, new Date());
    const cvs = [await makeCandidate({ job }), await makeCandidate({ job, text: `${CV_TEXT}\nTwo` })];

    await scheduleCandidateProcessing(cvs.map((c) => c.id));
    expect(sentIds()).toEqual(cvs.map((c) => c.id));
  });

  it("sends nothing while no AI provider is configured; the re-queue sends it once one is", async () => {
    mocks.model = null;
    const c = await makeCandidate();

    await scheduleCandidateProcessing([c.id]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await reload(c.id)).status).toBe("pending");
  });

  it("gives a CV's first event the id its re-queue uses, so Inngest drops the re-queue of a queued CV", async () => {
    const c = await pendingCandidate(await makeJob((await makeCompany()).company.id), 60);

    await scheduleCandidateProcessing([c.id]);
    await requeuePendingCandidates(NOW);

    expect(sentIds()).toEqual([c.id, c.id]);
    const [first, requeue] = sentEventIds();
    expect(requeue).toBe(first);
  });

  it("gives a re-scored CV a new event id, so it always runs again, and keeps it until the CV is claimed", async () => {
    const c = await makeCandidate();
    await scheduleCandidateProcessing([c.id]);
    // Its run claims and scores it.
    expect(await runProcessCvSteps(c.id, "run-1", inline, [providerWith("gemini", workingModel())])).toBe("ready");

    // What markForRescore does, twice before the next run claims the CV.
    await setRow(c.id, { status: "pending", error: null, attempts: 0 });
    await scheduleCandidateProcessing([c.id]);
    await setRow(c.id, { status: "pending", error: null, attempts: 0 });
    await scheduleCandidateProcessing([c.id]);

    // The next run claims it; it hits the cap and goes back to pending; the employer re-scores again.
    await claimStep(c.id, "run-2");
    await setRow(c.id, { status: "pending", error: null, attempts: 0 });
    await scheduleCandidateProcessing([c.id]);

    const [first, rescore, rescoreAgain, afterRun2] = sentEventIds();
    expect(rescore).not.toBe(first);
    // The second re-score shares the queued run's id: that run reads the current job when it analyzes.
    expect(rescoreAgain).toBe(rescore);
    expect(afterRun2).not.toBe(rescore);
    expect(new Set([first, rescore, afterRun2]).size).toBe(3);
  });

  it("doesn't throw when Inngest can't be reached; the CV stays pending for the re-queue", async () => {
    mocks.send.mockRejectedValueOnce(new Error("503 from inn.gs"));
    const c = await makeCandidate();

    await expect(scheduleCandidateProcessing([c.id])).resolves.toBeUndefined();
    expect((await reload(c.id)).status).toBe("pending");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Inngest"), "503 from inn.gs");
  });

  it("sends nothing for an empty or fully deleted list", async () => {
    await scheduleCandidateProcessing([]);
    await scheduleCandidateProcessing(["gone"]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("scheduleCandidateProcessing on Netlify without Inngest", () => {
  it("processes the CVs in this invocation and says once per instance that Inngest is missing", async () => {
    vi.stubEnv("NETLIFY", "true");
    // Tests have no Netlify Blobs; extraction runs inline, as it would on Netlify.
    vi.stubEnv("STORAGE_DRIVER", "local");
    const first = await makeCandidate();
    const second = await makeCandidate();

    await scheduleCandidateProcessing([first.id]);
    await scheduleCandidateProcessing([second.id]);
    await waitForIdle();

    expect((await reload(first.id)).status).toBe("ready");
    expect((await reload(second.id)).status).toBe("ready");
    expect(mocks.send).not.toHaveBeenCalled();
    const warnings = vi.mocked(console.error).mock.calls.filter(([msg]) => String(msg).includes("without Inngest"));
    expect(warnings).toHaveLength(1);
  });
});

describe("requeuePendingCandidates", () => {
  it("sends pending CVs older than 5 minutes, oldest first, once per candidate per day", async () => {
    const job = await makeJob((await makeCompany()).company.id);
    const old = await pendingCandidate(job, 60);
    const older = await pendingCandidate(job, 90);
    const fresh = await pendingCandidate(job, 4);
    const ready = await pendingCandidate(job, 120);
    await setRow(ready.id, { status: "ready" });

    expect(await requeuePendingCandidates(NOW)).toBe(2);

    expect(sentIds()).toEqual([older.id, old.id]);
    expect(sentIds()).not.toContain(fresh.id);
    expect(sentEventIds()).toEqual([processEventId(older.id, null), processEventId(old.id, null)]);
  });

  it("re-sends a CV stuck processing since a claim over 30 minutes old, but not one claimed recently", async () => {
    const job = await makeJob((await makeCompany()).company.id);
    const stuck = await processingCandidate(job, 31, "run-0");
    const legacy = await processingCandidate(job, null, null);
    const working = await processingCandidate(job, 10, "run-9");

    expect(await requeuePendingCandidates(NOW)).toBe(2);

    expect(sentIds()).toEqual(expect.arrayContaining([stuck.id, legacy.id]));
    expect(sentIds()).not.toContain(working.id);
    // Its own id, once per stuck claim: not the id that started the stuck run.
    const ids = Object.fromEntries(mocks.send.mock.calls[0][0].map((r) => [r.id, r.eventId]));
    expect(ids[stuck.id]).toBe(`cv-${stuck.id}-run-0-stale`);
    expect(ids[stuck.id]).not.toBe(processEventId(stuck.id, "run-0"));
  });

  it("lets the re-sent run take the stuck CV over and finish it", async () => {
    const job = await makeJob((await makeCompany()).company.id);
    const stuck = await processingCandidate(job, 45, "run-0");
    await requeuePendingCandidates(NOW);
    expect(sentIds()).toEqual([stuck.id]);

    // The run the re-sent event starts.
    expect(await runProcessCvSteps(stuck.id, "run-1", inline, [providerWith("gemini", workingModel())])).toBe("ready");
    expect(await reload(stuck.id)).toMatchObject({ status: "ready", attempts: 2, score: 82 });
  });

  it("counts stuck CVs against the company's remaining allowance, like pending ones", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "2");
    const job = await makeJob((await makeCompany()).company.id);
    await usedToday(job.companyId, 1);
    const stuck = await processingCandidate(job, 60);
    const pending = await pendingCandidate(job, 30);

    await requeuePendingCandidates(NOW);
    // Oldest first: the stuck CV (created 2 hours ago) takes the one slot left.
    expect(sentIds()).toEqual([stuck.id]);
    expect(sentIds()).not.toContain(pending.id);
  });

  it("skips companies that have used today's cap, and sends no more than each company has left", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "3");
    const capped = await makeJob((await makeCompany()).company.id);
    const partly = await makeJob((await makeCompany()).company.id);
    const fresh = await makeJob((await makeCompany()).company.id);
    await usedToday(capped.companyId, 3);
    await usedToday(partly.companyId, 2);
    const cappedCv = await pendingCandidate(capped, 30);
    const partlyCvs = [await pendingCandidate(partly, 30), await pendingCandidate(partly, 20)];
    const freshCvs = [await pendingCandidate(fresh, 30), await pendingCandidate(fresh, 20)];

    await requeuePendingCandidates(NOW);

    expect(sentIds()).not.toContain(cappedCv.id);
    // 1 slot left: only the oldest.
    expect(sentIds()).toContain(partlyCvs[0].id);
    expect(sentIds()).not.toContain(partlyCvs[1].id);
    expect(sentIds()).toEqual(expect.arrayContaining(freshCvs.map((c) => c.id)));
  });

  it("counts only today's usage: yesterday's cap doesn't hold a CV back", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const job = await makeJob((await makeCompany()).company.id);
    await db.insert(aiUsage).values({ companyId: job.companyId, day: "2026-10-06", analyses: 1 });
    const c = await pendingCandidate(job, 600);

    await requeuePendingCandidates(NOW);
    expect(sentIds()).toEqual([c.id]);
  });

  it("sends everything pending when the cap is off", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "0");
    const job = await makeJob((await makeCompany()).company.id);
    await usedToday(job.companyId, 10_000);
    const c = await pendingCandidate(job, 30);

    await requeuePendingCandidates(NOW);
    expect(sentIds()).toEqual([c.id]);
  });

  it("sends nothing while no AI provider is configured", async () => {
    mocks.model = null;
    await pendingCandidate(await makeJob((await makeCompany()).company.id), 30);

    expect(await requeuePendingCandidates(NOW)).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("re-sends a CV that went back to pending because every model was busy, under a new event id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(minutesAgo(30));
    // A cap of 1: the busy run's charge must have been refunded for the CV to be sent again today.
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    try {
      const job = await makeJob((await makeCompany()).company.id);
      const c = await pendingCandidate(job, 60);
      // The run its first event (`cv-<id>-new`) started.
      expect(await runProcessCvSteps(c.id, "run-1", inline, [providerWith("gemini", busyModel())])).toBe("ai-busy");
      expect(await reload(c.id)).toMatchObject({ status: "pending", aiRetries: 1 });

      vi.setSystemTime(NOW);
      expect(await requeuePendingCandidates(NOW)).toBe(1);

      // Named after the busy run's claim: not the first event's id, so Inngest doesn't drop it.
      expect(sentIds()).toEqual([c.id]);
      expect(sentEventIds()).toEqual([`cv-${c.id}-run-1`]);
      expect(sentEventIds()).not.toContain(processEventId(c.id, null));

      // The run that event starts finds the AI back and finishes the CV.
      expect(await runProcessCvSteps(c.id, "run-2", inline, [providerWith("gemini", workingModel())])).toBe("ready");
      expect(await reload(c.id)).toMatchObject({ status: "ready", error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends at most 200 per run", async () => {
    const job = await makeJob((await makeCompany()).company.id);
    const rows = Array.from({ length: 205 }, (_, i) => ({
      jobId: job.id,
      companyId: job.companyId,
      source: "upload" as const,
      cvFileKey: `${crypto.randomUUID()}.txt`,
      cvFileName: "cv.txt",
      cvMimeType: "text/plain",
      cvSize: 1,
      cvSha256: crypto.randomUUID(),
      createdAt: minutesAgo(10 + i),
    }));
    const inserted = await db.insert(candidates).values(rows).returning({ id: candidates.id });

    const found = (await findRequeueCandidates(NOW)).map((r) => r.id);
    // Oldest first: the 5 youngest (inserted first, 10–14 minutes old) wait for the next run.
    expect(found).toEqual(inserted.slice(5).map((r) => r.id).reverse());
  });
});
