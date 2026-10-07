import "server-only";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { aiUsage, candidates, jobs } from "@/db/schema";
import { sendCvProcessRequested } from "@/inngest/client";
import { AiAnalysisError, AiNotConfiguredError, analyzeCv } from "@/lib/ai/analyze";
import { resolveProviderChain } from "@/lib/ai/providers";
import { dailyLimit, tryReserveAnalysis, utcDay } from "@/lib/ai/quota";
import { describeError } from "@/lib/log";
import { TaskQueue } from "@/lib/pipeline/queue";
import { executionMode } from "@/lib/pipeline/runtime";
import {
  CvUnreadableError,
  GAVE_UP_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  MAX_ATTEMPTS,
  claimPending,
  markFailed,
  readCvText,
  releaseForQuota,
  saveAnalysis,
  saveCvText,
} from "@/lib/pipeline/steps";

// CONTRACT (frozen) — implemented by the AI/pipeline workstream. Background text extraction + AI analysis.
// How CVs run depends on the environment (see executionMode in ./runtime): Inngest runs on serverless, an in-process
// queue on a long-lived server.

/** In-process mode: how often pending CVs are re-queued (quota resets, provider added, missed schedules). */
const REQUEUE_INTERVAL_MS = 5 * 60 * 1000;
const REQUEUE_BATCH = 1000;
/** Inngest mode: pending CVs younger than this are left alone; their own event is most likely still on its way. */
const REQUEUE_MIN_AGE_MS = 5 * 60 * 1000;
const REQUEUE_CRON_BATCH = 200;
const LOOKUP_CHUNK = 500;

const concurrency = () => Number(process.env.AI_CONCURRENCY) || 3;

// Intentional: cached on globalThis so a dev hot reload keeps one queue (and its dedupe state) per process.
const globalForQueue = globalThis as unknown as {
  __cvPipelineQueue?: TaskQueue;
  __cvPipelineInFlight?: Set<Promise<unknown>>;
  __cvWarnedNoInngest?: boolean;
};
const queue = (globalForQueue.__cvPipelineQueue ??= new TaskQueue(processCandidate, concurrency));
queue.worker = processCandidate;
/** Re-queues still looking up their candidates; waitForIdle waits for them as well as the queue. */
const inFlight = (globalForQueue.__cvPipelineInFlight ??= new Set());

type QueuedCandidate = { id: string; companyId: string };

/**
 * Queues candidates for text extraction + AI analysis without blocking the response. Never throws: the rows are
 * already saved as "pending", and the periodic re-queue picks up anything that couldn't be scheduled.
 * Safe to call from Route Handlers and Server Actions. Callers must have already set the rows to status "pending".
 */
export async function scheduleCandidateProcessing(candidateIds: string[]): Promise<void> {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return;

  let rows: QueuedCandidate[];
  try {
    rows = await lookupCompanies(ids);
  } catch (err) {
    // Intentional: not rethrown — see above.
    console.error("[pipeline] could not schedule candidates:", describeError(err, { withStack: true }));
    return;
  }
  if (rows.length === 0) return;

  const mode = executionMode();
  if (mode === "inngest") {
    try {
      await sendCvProcessRequested(rows);
    } catch (err) {
      // Intentional: not rethrown — the re-queue cron sends events for CVs still pending after a few minutes.
      console.error("[pipeline] could not send CVs to Inngest:", describeError(err));
    }
    return;
  }

  if (mode === "netlify-after") warnNoInngestOnce();
  const batch = enqueueAll(rows);
  try {
    // On serverless this keeps the invocation alive until the batch finishes (within its time limit).
    after(() => batch);
  } catch {
    // Intentional: `after` throws outside a request scope (boot recovery, tests). The queue is in-process,
    // so the work still runs.
  }
}

/** The caller's order (so each company's CVs are processed in arrival order); deleted ids are skipped. */
async function lookupCompanies(ids: string[]): Promise<QueuedCandidate[]> {
  const companyOf = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const rows = await db
      .select({ id: candidates.id, companyId: candidates.companyId })
      .from(candidates)
      .where(inArray(candidates.id, ids.slice(i, i + LOOKUP_CHUNK)));
    for (const row of rows) companyOf.set(row.id, row.companyId);
  }
  return ids.flatMap((id) => {
    const companyId = companyOf.get(id);
    return companyId ? [{ id, companyId }] : [];
  });
}

function warnNoInngestOnce(): void {
  if (globalForQueue.__cvWarnedNoInngest) return;
  globalForQueue.__cvWarnedNoInngest = true;
  console.error(
    "[pipeline] Running on Netlify without Inngest: set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY. Until then CVs are " +
      "analyzed inside the upload request with after(), only as many as fit in its 60 s, and nothing retries the rest.",
  );
}

function enqueueAll(rows: QueuedCandidate[]): Promise<void> {
  return Promise.all(rows.map((row) => queue.enqueue(row.id, row.companyId))).then(
    () => undefined,
    () => undefined,
  );
}

/** In-process mode: run the full pipeline for one candidate now. Never throws: failures are written to the row. */
export async function processCandidate(candidateId: string): Promise<void> {
  try {
    const { chain } = resolveProviderChain();
    // Intentional: with no AI provider the row isn't claimed. It stays pending, with no error, until a key is
    // added and the server restarts; boot recovery and the periodic re-queue then pick it up.
    if (chain.length === 0) return;

    const candidate = await claimPending(candidateId);
    if (!candidate) return;

    try {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, candidate.jobId)).limit(1);
      if (!job) throw new Error(`Job ${candidate.jobId} not found`);

      let cvText = candidate.cvText;
      if (cvText == null) {
        cvText = await readCvText(candidate.cvFileKey);
        if (!(await saveCvText(candidate.id, cvText))) return;
      }

      // Charged only now, right before the AI call: an unreadable CV never uses up the company's daily cap.
      if (!(await tryReserveAnalysis(candidate.companyId))) {
        await releaseForQuota(candidate.id);
        return;
      }

      await saveAnalysis(candidate.id, await analyzeCv({ cvText, job }, chain));
    } catch (err) {
      const known = err instanceof AiNotConfiguredError || err instanceof AiAnalysisError || err instanceof CvUnreadableError;
      console.error(`[pipeline] candidate ${candidate.id} failed:`, describeError(err, { withStack: !known }));
      await markFailed(candidate.id, known ? (err as Error).message : GENERIC_FAILURE_MESSAGE);
    }
  } catch (err) {
    console.error(`[pipeline] could not process candidate ${candidateId}:`, describeError(err, { withStack: true }));
  }
}

/**
 * In-process mode, on server boot: re-queue candidates left "pending"/"processing" by a previous process. A CV
 * that was mid-processing on each of its last MAX_ATTEMPTS claims is failed instead, so a file that kills the
 * process can't crash-loop the server.
 */
export async function recoverInterruptedCandidates(): Promise<void> {
  try {
    await db
      .update(candidates)
      .set({ status: "failed", error: GAVE_UP_MESSAGE })
      .where(and(eq(candidates.status, "processing"), gte(candidates.attempts, MAX_ATTEMPTS)));
    await db.update(candidates).set({ status: "pending" }).where(eq(candidates.status, "processing"));
    void enqueueAll(await pendingCandidates());
  } catch (err) {
    console.error("[pipeline] recovery failed:", describeError(err, { withStack: true }));
  }
}

/** In-process mode: every few minutes, re-queue `pending` candidates. Idempotent per process. */
export function startPendingRequeue(): void {
  const g = globalThis as unknown as { __cvPendingRequeueTimer?: ReturnType<typeof setInterval> };
  if (g.__cvPendingRequeueTimer) return;
  // Intentional: no tick on start — boot recovery has just queued every pending candidate.
  g.__cvPendingRequeueTimer = setInterval(() => track(requeuePending()), REQUEUE_INTERVAL_MS);
  g.__cvPendingRequeueTimer.unref();
}

async function requeuePending(): Promise<void> {
  try {
    // Nothing could be processed; skip the no-op claims.
    if (resolveProviderChain().chain.length === 0) return;
    void enqueueAll(await pendingCandidates(REQUEUE_BATCH));
  } catch (err) {
    console.error("[pipeline] re-queue failed:", describeError(err, { withStack: true }));
  }
}

/** Oldest first. */
async function pendingCandidates(limit?: number): Promise<QueuedCandidate[]> {
  const query = db
    .select({ id: candidates.id, companyId: candidates.companyId })
    .from(candidates)
    .where(eq(candidates.status, "pending"))
    .orderBy(asc(candidates.createdAt));
  return limit ? query.limit(limit) : query;
}

/**
 * Inngest mode (the `requeue-pending` cron): sends events for CVs still pending after a few minutes — a lost event,
 * a cap that reset at midnight UTC, a provider added since. Returns how many were sent. Sends only what can run now,
 * so free-plan executions aren't spent on claims that would bounce straight back to pending.
 */
export async function requeuePendingCandidates(now: Date = new Date()): Promise<number> {
  if (resolveProviderChain().chain.length === 0) return 0;
  const rows = await findRequeueCandidates(now);
  if (rows.length === 0) return 0;
  // Intentional: at most one re-queue per candidate per UTC day (Inngest drops repeated event ids for 24 h). A
  // pending CV may simply be waiting behind its company's concurrency limit; re-sending it every 30 minutes would
  // replace its queued run each time. A run that hits the cap after its re-queue can't run again until tomorrow.
  await sendCvProcessRequested(rows, { dedupeKey: `requeue-${utcDay(now)}` });
  return rows.length;
}

/**
 * Pending CVs older than REQUEUE_MIN_AGE_MS, oldest first, at most REQUEUE_CRON_BATCH, and per company no more
 * than its remaining AI allowance today (all of them when the cap is off).
 */
export async function findRequeueCandidates(now: Date = new Date()): Promise<QueuedCandidate[]> {
  const limit = dailyLimit();
  const ranked = db
    .select({
      id: candidates.id,
      companyId: candidates.companyId,
      createdAt: candidates.createdAt,
      rank: sql<number>`row_number() over (partition by ${candidates.companyId} order by ${candidates.createdAt}, ${candidates.id})`.as(
        "rank",
      ),
      used: sql<number>`coalesce(${aiUsage.analyses}, 0)`.as("used"),
    })
    .from(candidates)
    .leftJoin(aiUsage, and(eq(aiUsage.companyId, candidates.companyId), eq(aiUsage.day, utcDay(now))))
    .where(
      and(
        eq(candidates.status, "pending"),
        lte(candidates.createdAt, new Date(now.getTime() - REQUEUE_MIN_AGE_MS)),
      ),
    )
    .as("ranked");
  return db
    .select({ id: ranked.id, companyId: ranked.companyId })
    .from(ranked)
    .where(limit == null ? undefined : sql`${ranked.rank} <= ${limit} - ${ranked.used}`)
    .orderBy(asc(ranked.createdAt), asc(ranked.id))
    .limit(REQUEUE_CRON_BATCH);
}

/** Test-only: resolves once nothing is being looked up, waiting or running in the in-process queue. */
export async function waitForIdle(): Promise<void> {
  for (;;) {
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
      continue;
    }
    await queue.onIdle();
    if (inFlight.size === 0) return;
  }
}

function track(promise: Promise<unknown>): void {
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise));
}
