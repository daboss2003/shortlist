import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { candidates, jobs, type Candidate } from "@/db/schema";
import { AiAnalysisError, analyzeCvWithProvider, type AnalyzeResult } from "@/lib/ai/analyze";
import { resolveProviderChain, type ResolvedProvider } from "@/lib/ai/providers";
import { tryReserveAnalysis } from "@/lib/ai/quota";
import { extractCvText } from "@/lib/cv/extract-text";
import { CV_FILE_TYPES, type CvFileType } from "@/lib/cv/file-type";
import { describeError } from "@/lib/log";
import { readCvFile } from "@/lib/storage";

// The pipeline's units of work for one candidate: claim → extract text → reserve quota → analyze → save.
// processCandidate (in-process mode) calls the shared helpers directly; the Inngest function runs
// runProcessCvSteps, where each unit is a durable step that must finish well inside Netlify's 60 s.
// Every write after a claim is conditional on the row still being "processing" (see `stillClaimed`).

const MIN_CV_TEXT_CHARS = 100;
const MAX_STORED_CV_CHARS = 100_000;
/** Claims (since the last re-score) after which a CV that was interrupted each time is failed instead of retried. */
export const MAX_ATTEMPTS = 3;
/** One provider's budget inside one step: under Netlify's 60 s, with room for the DB reads around the call. */
export const PROVIDER_STEP_TIMEOUT_MS = 45_000;

export const UNREADABLE_CV_MESSAGE =
  "We couldn't read any text from this CV. It may be a scanned image — upload a text-based PDF or Word file.";
export const GENERIC_FAILURE_MESSAGE = "Something went wrong while analyzing this CV. Try re-scoring it.";
export const GAVE_UP_MESSAGE = "We couldn't process this CV. Try re-scoring it, or ask the candidate for a different file.";

/** Message is safe to show to the employer. */
export class CvUnreadableError extends Error {}

/**
 * Writes after the claim land only while the row is still ours. A re-score meanwhile resets it to "pending" and
 * the CV is processed again (against the current job), so a superseded run's results are discarded.
 */
const stillClaimed = (candidateId: string) => and(eq(candidates.id, candidateId), eq(candidates.status, "processing"));

// ── Shared by both modes ──

/** Atomic claim: only one caller can move a row out of "pending". */
export async function claimPending(candidateId: string): Promise<Candidate | undefined> {
  const [candidate] = await db
    .update(candidates)
    .set({ status: "processing", error: null, attempts: sql`${candidates.attempts} + 1` })
    .where(and(eq(candidates.id, candidateId), eq(candidates.status, "pending")))
    .returning();
  return candidate;
}

/** Reads and extracts the CV file. Throws CvUnreadableError (employer-safe) for files with no usable text. */
export async function readCvText(fileKey: string): Promise<string> {
  const bytes = await readCvFile(fileKey);
  let text: string;
  try {
    text = await extractCvText(bytes, fileTypeOf(fileKey));
  } catch (err) {
    // Corrupt, encrypted, hostile or mislabelled files: the employer's fix is the same as for an image-only scan.
    console.error(`[pipeline] text extraction failed for ${fileKey}:`, describeError(err));
    throw new CvUnreadableError(UNREADABLE_CV_MESSAGE);
  }
  if (text.length < MIN_CV_TEXT_CHARS) throw new CvUnreadableError(UNREADABLE_CV_MESSAGE);
  return sliceSafe(text, MAX_STORED_CV_CHARS);
}

/** False when the claim was lost. */
export async function saveCvText(candidateId: string, cvText: string): Promise<boolean> {
  const rows = await db.update(candidates).set({ cvText }).where(stillClaimed(candidateId)).returning({ id: candidates.id });
  return rows.length > 0;
}

/**
 * Daily AI cap reached: back to pending (the extracted text is kept), and this claim doesn't count as an attempt.
 * The re-queue retries it once the UTC day rolls over.
 */
export async function releaseForQuota(candidateId: string): Promise<void> {
  await db
    .update(candidates)
    .set({ status: "pending", attempts: sql`${candidates.attempts} - 1` })
    .where(stillClaimed(candidateId));
}

/** Stores the analysis and marks the candidate ready. False when the claim was lost (nothing written). */
export async function saveAnalysis(candidateId: string, { analysis, provider, modelId }: AnalyzeResult): Promise<boolean> {
  const { profile, evaluation } = analysis;
  const rows = await db
    .update(candidates)
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
    .where(stillClaimed(candidateId))
    .returning({ id: candidates.id });
  return rows.length > 0;
}

/** `message` must be employer-safe. False when the claim was lost (nothing written). */
export async function markFailed(candidateId: string, message: string): Promise<boolean> {
  const rows = await db
    .update(candidates)
    .set({ status: "failed", error: message })
    .where(stillClaimed(candidateId))
    .returning({ id: candidates.id });
  return rows.length > 0;
}

// ── Durable (Inngest) steps. Each returns plain JSON: it is stored as the step's result. ──

export type ClaimStepResult = { claimed: true; companyId: string; needsText: boolean } | { claimed: false; gaveUp: boolean };

/**
 * Claims the row for this run. A row already "processing" is taken over too: runs are singletons per candidate
 * (a newer run cancels the older one), so it belongs to a cancelled run, or to this run's own claim whose result
 * was lost and is being retried. Each claim counts an attempt; past MAX_ATTEMPTS the CV is failed, so a file that
 * kills the function every time can't loop forever.
 */
export async function claimStep(candidateId: string): Promise<ClaimStepResult> {
  const [row] = await db
    .update(candidates)
    .set({ status: "processing", error: null, attempts: sql`${candidates.attempts} + 1` })
    .where(and(eq(candidates.id, candidateId), inArray(candidates.status, ["pending", "processing"])))
    .returning({
      companyId: candidates.companyId,
      attempts: candidates.attempts,
      hasText: sql<boolean>`${candidates.cvText} is not null`,
    });
  if (!row) return { claimed: false, gaveUp: false };
  if (row.attempts > MAX_ATTEMPTS) {
    await markFailed(candidateId, GAVE_UP_MESSAGE);
    return { claimed: false, gaveUp: true };
  }
  return { claimed: true, companyId: row.companyId, needsText: !row.hasText };
}

export type ExtractStepResult = "ok" | "unreadable" | "superseded";

/** Extracts and stores the CV text (inline on serverless). Storage and DB errors throw, so the step is retried. */
export async function extractStep(candidateId: string): Promise<ExtractStepResult> {
  const [row] = await db
    .select({ cvFileKey: candidates.cvFileKey, hasText: sql<boolean>`${candidates.cvText} is not null` })
    .from(candidates)
    .where(stillClaimed(candidateId))
    .limit(1);
  if (!row) return "superseded";
  if (row.hasText) return "ok";

  let cvText: string;
  try {
    cvText = await readCvText(row.cvFileKey);
  } catch (err) {
    if (!(err instanceof CvUnreadableError)) throw err;
    // Not retried: the same file gives the same result.
    return (await markFailed(candidateId, err.message)) ? "unreadable" : "superseded";
  }
  return (await saveCvText(candidateId, cvText)) ? "ok" : "superseded";
}

export type ReserveStepResult = "reserved" | "quota-reached";

/** Charged only now, after extraction: an unreadable CV never uses up the company's daily cap. */
export async function reserveQuotaStep(candidateId: string, companyId: string): Promise<ReserveStepResult> {
  if (await tryReserveAnalysis(companyId)) return "reserved";
  await releaseForQuota(candidateId);
  return "quota-reached";
}

export type AnalyzeStepResult =
  | { status: "ok"; result: AnalyzeResult }
  | { status: "failed"; reason: string }
  | { status: "superseded" };

/**
 * One provider of the fallback chain. A provider failure is returned, not thrown, so the run moves on to the next
 * provider instead of Inngest retrying this one.
 */
export async function analyzeStep(
  candidateId: string,
  provider: ResolvedProvider,
  { timeoutMs = PROVIDER_STEP_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<AnalyzeStepResult> {
  const [row] = await db
    .select({ cvText: candidates.cvText, job: jobs })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .where(stillClaimed(candidateId))
    .limit(1);
  if (!row) return { status: "superseded" };
  // The claim step only skips extraction when the text exists, and nothing clears it.
  if (row.cvText == null) throw new Error(`Candidate ${candidateId} has no extracted text to analyze`);

  const attempt = await analyzeCvWithProvider({ cvText: row.cvText, job: row.job }, provider, { timeoutMs });
  return attempt.ok ? { status: "ok", result: attempt.result } : { status: "failed", reason: attempt.reason };
}

/** What runs one durable step. Inngest's `step` in production; tests pass `{ run: (id, fn) => fn() }`. */
export type StepRunner = { run<T>(id: string, fn: () => Promise<T>): Promise<T> };

export type ProcessCvOutcome =
  | "no-provider"
  | "not-claimed"
  | "gave-up"
  | "unreadable"
  | "quota-reached"
  | "superseded"
  | "ready"
  | "ai-failed";

/** The Inngest process-cv run for one candidate: one step per unit of work, one step per provider. */
export async function runProcessCvSteps(
  candidateId: string,
  step: StepRunner,
  chain: ResolvedProvider[] = resolveProviderChain().chain,
): Promise<ProcessCvOutcome> {
  // Intentional: with no AI provider the row isn't claimed. It stays pending, with no error, until a key is added;
  // the re-queue cron then picks it up.
  if (chain.length === 0) return "no-provider";

  const claim = await step.run("claim", () => claimStep(candidateId));
  if (!claim.claimed) return claim.gaveUp ? "gave-up" : "not-claimed";

  if (claim.needsText) {
    const extracted = await step.run("extract", () => extractStep(candidateId));
    if (extracted !== "ok") return extracted;
  }

  const quota = await step.run("reserve-quota", () => reserveQuotaStep(candidateId, claim.companyId));
  if (quota !== "reserved") return quota;

  for (const provider of chain) {
    const attempt = await step.run(`analyze-${provider.id}`, () => analyzeStep(candidateId, provider));
    if (attempt.status === "superseded") return "superseded";
    if (attempt.status === "ok") {
      const saved = await step.run("save", () => saveAnalysis(candidateId, attempt.result));
      return saved ? "ready" : "superseded";
    }
  }

  const failed = await step.run("mark-failed", () => markFailed(candidateId, new AiAnalysisError().message));
  return failed ? "ai-failed" : "superseded";
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
