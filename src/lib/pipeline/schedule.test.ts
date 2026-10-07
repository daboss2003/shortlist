import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { aiUsage, candidates, type Job } from "@/db/schema";
import { makeCompany, makeJob } from "../../../test/factories";
import { findRequeueCandidates, requeuePendingCandidates, scheduleCandidateProcessing, waitForIdle } from "./index";
import { executionMode } from "./runtime";
import { CV_TEXT, makeCandidate, reload, setRow, workingModel } from "./test-helpers";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(rows: Array<{ id: string; companyId: string }>, opts?: { dedupeKey?: string }) => Promise<void>>(),
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

/** A pending candidate created `ageMinutes` before NOW. */
async function pendingCandidate(job: Job, ageMinutes: number) {
  const c = await makeCandidate({ job, text: `${CV_TEXT}\n${crypto.randomUUID()}` });
  await setRow(c.id, { createdAt: minutesAgo(ageMinutes) });
  return c;
}

async function usedToday(companyId: string, analyses: number) {
  await db.insert(aiUsage).values({ companyId, day: "2026-10-07", analyses });
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
      { id: b.id, companyId: b.companyId },
      { id: a.id, companyId: a.companyId },
    ]);
    // No re-queue dedupe id: a re-score must always get a fresh run.
    expect(mocks.send.mock.calls[0][1]).toBeUndefined();
    // Nothing runs in this process.
    await waitForIdle();
    expect((await reload(a.id)).status).toBe("pending");
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
    expect(mocks.send.mock.calls[0][1]).toEqual({ dedupeKey: "requeue-2026-10-07" });
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
