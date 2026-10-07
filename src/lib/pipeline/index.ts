import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { candidates, jobs } from "@/db/schema";
import { AiAnalysisError, AiNotConfiguredError, analyzeCv } from "@/lib/ai/analyze";
import { extractCvText } from "@/lib/cv/extract-text";
import { CV_FILE_TYPES, type CvFileType } from "@/lib/cv/file-type";
import { readCvFile } from "@/lib/storage";
import { TaskQueue } from "@/lib/pipeline/queue";

// CONTRACT (frozen) — implemented by the AI/pipeline workstream.

const MIN_CV_TEXT_CHARS = 100;
const UNREADABLE_CV_MESSAGE =
  "We couldn't read any text from this CV. It may be a scanned image — upload a text-based PDF or Word file.";
const GENERIC_FAILURE_MESSAGE = "Something went wrong while analyzing this CV. Try re-scoring it.";

/** Message is safe to show to the employer. */
class CvUnreadableError extends Error {}

const concurrency = () => Number(process.env.AI_CONCURRENCY) || 3;

// Intentional: cached on globalThis so a dev hot reload keeps one queue (and its dedupe state) per process.
const globalForQueue = globalThis as unknown as { __cvPipelineQueue?: TaskQueue };
const queue = (globalForQueue.__cvPipelineQueue ??= new TaskQueue(processCandidate, concurrency));
queue.worker = processCandidate;

/**
 * Queue candidates for text extraction + AI analysis without blocking the response.
 * Safe to call from Route Handlers and Server Actions (uses next/server `after()` when in a request).
 * Callers must have already set the candidate rows to status "pending".
 */
export function scheduleCandidateProcessing(candidateIds: string[]): void {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return;

  const batch = Promise.all(ids.map((id) => queue.enqueue(id))).then(
    () => undefined,
    () => undefined,
  );
  try {
    after(() => batch);
  } catch {
    // Intentional: `after` throws outside a request scope (boot recovery, tests). The queue is in-process,
    // so the work still runs; `after` only keeps a serverless request alive until the batch finishes.
  }
}

/** Run the full pipeline for one candidate now. Never throws: failures are written to the row. */
export async function processCandidate(candidateId: string): Promise<void> {
  try {
    // Atomic claim: only one caller can move a row out of "pending".
    const candidate = db
      .update(candidates)
      .set({ status: "processing", error: null })
      .where(and(eq(candidates.id, candidateId), eq(candidates.status, "pending")))
      .returning()
      .get();
    if (!candidate) return;

    try {
      const job = db.select().from(jobs).where(eq(jobs.id, candidate.jobId)).get();
      if (!job) throw new Error(`Job ${candidate.jobId} not found`);

      let cvText = candidate.cvText;
      if (cvText == null) {
        cvText = await readCvText(candidate.cvFileKey);
        db.update(candidates).set({ cvText }).where(eq(candidates.id, candidate.id)).run();
      }

      const { analysis, provider, modelId } = await analyzeCv({ cvText, job });
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
        .where(eq(candidates.id, candidate.id))
        .run();
    } catch (err) {
      const known = err instanceof AiNotConfiguredError || err instanceof AiAnalysisError || err instanceof CvUnreadableError;
      console.error(`[pipeline] candidate ${candidate.id} failed:`, err instanceof Error ? (known ? err.message : err.stack) : err);
      db.update(candidates)
        .set({ status: "failed", error: known ? (err as Error).message : GENERIC_FAILURE_MESSAGE })
        .where(eq(candidates.id, candidate.id))
        .run();
    }
  } catch (err) {
    console.error(`[pipeline] could not process candidate ${candidateId}:`, err instanceof Error ? err.stack : err);
  }
}

/** On server boot: re-queue candidates left "pending"/"processing" by a previous process. */
export async function recoverInterruptedCandidates(): Promise<void> {
  try {
    db.update(candidates).set({ status: "pending" }).where(eq(candidates.status, "processing")).run();
    const ids = db
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.status, "pending"))
      .all()
      .map((r) => r.id);
    scheduleCandidateProcessing(ids);
  } catch (err) {
    console.error("[pipeline] recovery failed:", err instanceof Error ? err.stack : err);
  }
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
    // Corrupt, encrypted or mislabelled files: the employer's fix is the same as for an image-only scan.
    console.error(`[pipeline] text extraction failed for ${fileKey}:`, err instanceof Error ? err.message : err);
    throw new CvUnreadableError(UNREADABLE_CV_MESSAGE);
  }
  if (text.length < MIN_CV_TEXT_CHARS) throw new CvUnreadableError(UNREADABLE_CV_MESSAGE);
  return text;
}

/** Storage keys are server-generated as `<uuid>.<type>`. */
function fileTypeOf(fileKey: string): CvFileType {
  const ext = fileKey.split(".").pop();
  const type = CV_FILE_TYPES.find((t) => t === ext);
  if (!type) throw new Error(`Unexpected CV storage key extension: ${ext}`);
  return type;
}
