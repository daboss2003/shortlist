import "server-only";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { candidates, jobs } from "@/db/schema";
import { AiAnalysisError, AiNotConfiguredError, analyzeCv } from "@/lib/ai/analyze";
import { resolveProviderChain } from "@/lib/ai/providers";
import { tryReserveAnalysis } from "@/lib/ai/quota";
import { extractCvText } from "@/lib/cv/extract-text";
import { CV_FILE_TYPES, type CvFileType } from "@/lib/cv/file-type";
import { readCvFile } from "@/lib/storage";
import { TaskQueue } from "@/lib/pipeline/queue";

// CONTRACT (frozen) — implemented by the AI/pipeline workstream.

const MIN_CV_TEXT_CHARS = 100;
const MAX_STORED_CV_CHARS = 100_000;
/** Claims (since the last re-score) after which boot recovery stops retrying a CV that was interrupted each time. */
const MAX_ATTEMPTS = 3;
const REQUEUE_INTERVAL_MS = 5 * 60 * 1000;
const REQUEUE_BATCH = 1000;
const LOOKUP_CHUNK = 500;

const UNREADABLE_CV_MESSAGE =
  "We couldn't read any text from this CV. It may be a scanned image — upload a text-based PDF or Word file.";
const GENERIC_FAILURE_MESSAGE = "Something went wrong while analyzing this CV. Try re-scoring it.";
const GAVE_UP_MESSAGE = "We couldn't process this CV. Try re-scoring it, or ask the candidate for a different file.";

/** Message is safe to show to the employer. */
class CvUnreadableError extends Error {}

const concurrency = () => Number(process.env.AI_CONCURRENCY) || 3;

// Intentional: cached on globalThis so a dev hot reload keeps one queue (and its dedupe state) per process.
const globalForQueue = globalThis as unknown as { __cvPipelineQueue?: TaskQueue };
const queue = (globalForQueue.__cvPipelineQueue ??= new TaskQueue(processCandidate, concurrency));
queue.worker = processCandidate;

type QueuedCandidate = { id: string; companyId: string };

/**
 * Queue candidates for text extraction + AI analysis without blocking the response.
 * Safe to call from Route Handlers and Server Actions (uses next/server `after()` when in a request).
 * Callers must have already set the candidate rows to status "pending".
 */
export function scheduleCandidateProcessing(candidateIds: string[]): void {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return;

  const companyOf = new Map<string, string>();
  try {
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      const rows = db
        .select({ id: candidates.id, companyId: candidates.companyId })
        .from(candidates)
        .where(inArray(candidates.id, ids.slice(i, i + LOOKUP_CHUNK)))
        .all();
      for (const row of rows) companyOf.set(row.id, row.companyId);
    }
  } catch (err) {
    // Intentional: not rethrown — the rows are already saved as pending, and the periodic re-queue picks them up.
    console.error("[pipeline] could not schedule candidates:", err instanceof Error ? err.stack : err);
    return;
  }

  // Caller's order, so each company's CVs are processed in the order they arrived. Deleted ids are skipped.
  const batch = enqueueAll(ids.flatMap((id) => (companyOf.has(id) ? [{ id, companyId: companyOf.get(id)! }] : [])));
  try {
    after(() => batch);
  } catch {
    // Intentional: `after` throws outside a request scope (boot recovery, tests). The queue is in-process,
    // so the work still runs; `after` only keeps a serverless request alive until the batch finishes.
  }
}

function enqueueAll(rows: QueuedCandidate[]): Promise<void> {
  return Promise.all(rows.map((row) => queue.enqueue(row.id, row.companyId))).then(
    () => undefined,
    () => undefined,
  );
}

/** Run the full pipeline for one candidate now. Never throws: failures are written to the row. */
export async function processCandidate(candidateId: string): Promise<void> {
  try {
    const { chain } = resolveProviderChain();
    // Intentional: with no AI provider the row isn't claimed. It stays pending, with no error, until a key is
    // added and the server restarts; boot recovery and the periodic re-queue then pick it up.
    if (chain.length === 0) return;

    // Atomic claim: only one caller can move a row out of "pending".
    const candidate = db
      .update(candidates)
      .set({ status: "processing", error: null, attempts: sql`${candidates.attempts} + 1` })
      .where(and(eq(candidates.id, candidateId), eq(candidates.status, "pending")))
      .returning()
      .get();
    if (!candidate) return;

    // Every write after the claim lands only while the row is still ours. A re-score meanwhile resets it to
    // pending and the queue runs it again (against the current job), so this run's results are discarded.
    const stillClaimed = and(eq(candidates.id, candidate.id), eq(candidates.status, "processing"));

    try {
      const job = db.select().from(jobs).where(eq(jobs.id, candidate.jobId)).get();
      if (!job) throw new Error(`Job ${candidate.jobId} not found`);

      let cvText = candidate.cvText;
      if (cvText == null) {
        cvText = await readCvText(candidate.cvFileKey);
        if (db.update(candidates).set({ cvText }).where(stillClaimed).run().changes === 0) return;
      }

      // Charged only now, right before the AI call: an unreadable CV never uses up the company's daily cap.
      if (!tryReserveAnalysis(candidate.companyId)) {
        // Daily AI cap reached: back to pending (the extracted text is kept), and this claim doesn't count as
        // an attempt. The periodic re-queue retries it once the UTC day rolls over.
        db.update(candidates)
          .set({ status: "pending", attempts: sql`${candidates.attempts} - 1` })
          .where(stillClaimed)
          .run();
        return;
      }

      const { analysis, provider, modelId } = await analyzeCv({ cvText, job }, chain);
      const { profile, evaluation } = analysis;
      db.update(candidates)
        .set({
          profile,
          evaluation,
          score: evaluation.overallScore,
          aiProvider: provider,
          aiModel: modelId,
          status: "ready",
          error: null,
          processedAt: new Date(),
          // Only fill blanks: a public applicant's typed details always win over the AI's reading of the CV.
          name: sql`coalesce(${candidates.name}, ${profile.fullName})`,
          email: sql`coalesce(${candidates.email}, ${profile.email?.toLowerCase() ?? null})`,
          phone: sql`coalesce(${candidates.phone}, ${profile.phone})`,
        })
        .where(stillClaimed)
        .run();
    } catch (err) {
      const known = err instanceof AiNotConfiguredError || err instanceof AiAnalysisError || err instanceof CvUnreadableError;
      console.error(`[pipeline] candidate ${candidate.id} failed:`, err instanceof Error ? (known ? err.message : err.stack) : err);
      db.update(candidates)
        .set({ status: "failed", error: known ? (err as Error).message : GENERIC_FAILURE_MESSAGE })
        .where(stillClaimed)
        .run();
    }
  } catch (err) {
    console.error(`[pipeline] could not process candidate ${candidateId}:`, err instanceof Error ? err.stack : err);
  }
}

/**
 * On server boot: re-queue candidates left "pending"/"processing" by a previous process. A CV that was
 * mid-processing on each of its last MAX_ATTEMPTS claims is failed instead, so a file that kills the
 * process can't crash-loop the server.
 */
export async function recoverInterruptedCandidates(): Promise<void> {
  try {
    db.update(candidates)
      .set({ status: "failed", error: GAVE_UP_MESSAGE })
      .where(and(eq(candidates.status, "processing"), gte(candidates.attempts, MAX_ATTEMPTS)))
      .run();
    db.update(candidates).set({ status: "pending" }).where(eq(candidates.status, "processing")).run();
    void enqueueAll(pendingCandidates());
  } catch (err) {
    console.error("[pipeline] recovery failed:", err instanceof Error ? err.stack : err);
  }
}

/** Every few minutes, re-queue `pending` candidates (quota resets, provider added, missed schedules). Idempotent. */
export function startPendingRequeue(): void {
  const g = globalThis as unknown as { __cvPendingRequeueTimer?: ReturnType<typeof setInterval> };
  if (g.__cvPendingRequeueTimer) return;
  // Intentional: no tick on start — boot recovery has just queued every pending candidate.
  g.__cvPendingRequeueTimer = setInterval(requeuePending, REQUEUE_INTERVAL_MS);
  g.__cvPendingRequeueTimer.unref();
}

function requeuePending(): void {
  try {
    // Nothing could be processed; skip the no-op claims.
    if (resolveProviderChain().chain.length === 0) return;
    void enqueueAll(pendingCandidates(REQUEUE_BATCH));
  } catch (err) {
    console.error("[pipeline] re-queue failed:", err instanceof Error ? err.stack : err);
  }
}

/** Oldest first. */
function pendingCandidates(limit?: number): QueuedCandidate[] {
  const query = db
    .select({ id: candidates.id, companyId: candidates.companyId })
    .from(candidates)
    .where(eq(candidates.status, "pending"))
    .orderBy(asc(candidates.createdAt));
  return (limit ? query.limit(limit) : query).all();
}

/** Test-only: resolves once the background queue has nothing waiting or running. */
export function waitForIdle(): Promise<void> {
  return queue.onIdle();
}

async function readCvText(fileKey: string): Promise<string> {
  const bytes = await readCvFile(fileKey);
  let text: string;
  try {
    text = await extractCvText(bytes, fileTypeOf(fileKey));
  } catch (err) {
    // Corrupt, encrypted, hostile or mislabelled files: the employer's fix is the same as for an image-only scan.
    console.error(`[pipeline] text extraction failed for ${fileKey}:`, err instanceof Error ? err.message : err);
    throw new CvUnreadableError(UNREADABLE_CV_MESSAGE);
  }
  if (text.length < MIN_CV_TEXT_CHARS) throw new CvUnreadableError(UNREADABLE_CV_MESSAGE);
  return sliceSafe(text, MAX_STORED_CV_CHARS);
}

/** Storage keys are server-generated as `<uuid>.<type>`. */
function fileTypeOf(fileKey: string): CvFileType {
  const ext = fileKey.split(".").pop();
  const type = CV_FILE_TYPES.find((t) => t === ext);
  if (!type) throw new Error(`Unexpected CV storage key extension: ${ext}`);
  return type;
}

/** Slice without splitting a UTF-16 surrogate pair. */
function sliceSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
