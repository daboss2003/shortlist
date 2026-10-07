import "server-only";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiUsage, candidates, jobs, type Candidate } from "@/db/schema";
import { AI_BUSY_MESSAGE, AiAnalysisError, analyzeCvWithProvider, type AnalyzeResult } from "@/lib/ai/analyze";
import { isTransientAiFailure, type AiFailureCode } from "@/lib/ai/errors";
import { resolveProviderChain, type ResolvedProvider } from "@/lib/ai/providers";
import { chargeOnConflict, refundUsage, utcDay } from "@/lib/ai/quota";
import { extractCvText } from "@/lib/cv/extract-text";
import { CV_FILE_TYPES, type CvFileType } from "@/lib/cv/file-type";
import { describeError } from "@/lib/log";
import { readCvFile } from "@/lib/storage";

// The pipeline's units of work for one candidate: claim → extract text → reserve quota → analyze and save.
// processCandidate (in-process mode) calls the shared helpers directly; the Inngest function runs
// runProcessCvSteps, where each unit is a durable step that must finish well inside Netlify's 60 s.
// A claim stores a token (the Inngest run id, or a random UUID in-process). Every later write is conditional on the
// row still being "processing" under that token (see `ownedBy`), so a superseded or failed older run can't
// overwrite a newer one: a re-score resets the row to "pending", and a newer run's claim replaces the token.

const MIN_CV_TEXT_CHARS = 100;
const MAX_STORED_CV_CHARS = 100_000;
/** Claims (since the last re-score) after which a CV that was interrupted each time is failed instead of retried. */
export const MAX_ATTEMPTS = 3;
/**
 * Times (since the last re-score) every AI model may be busy for a CV before it is failed instead of re-queued: about
 * an hour of retries in-process (every 5 minutes), about 6 hours with Inngest (the 30-minute re-queue cron).
 */
export const MAX_AI_RETRIES = 12;
/** One provider's budget inside one step: under Netlify's 60 s, with room for the DB reads and the save around it. */
export const PROVIDER_STEP_TIMEOUT_MS = 45_000;

export const UNREADABLE_CV_MESSAGE =
  "We couldn't read any text from this CV. It may be a scanned image — upload a text-based PDF or Word file.";
export const GENERIC_FAILURE_MESSAGE = "Something went wrong while analyzing this CV. Try re-scoring it.";
export const GAVE_UP_MESSAGE = "We couldn't process this CV. Try re-scoring it, or ask the candidate for a different file.";

/** Message is safe to show to the employer. */
export class CvUnreadableError extends Error {}

/**
 * Intentional: claim_token also records whether the claim has been charged against the daily AI cap. reserveQuota
 * rewrites `<token>` to `<token>:charged` in the same statement as the charge, so a retried reservation (its first
 * response lost) sees the charge instead of counting it twice. Both forms are the same claim; no schema change needed.
 */
const CHARGED_SUFFIX = ":charged";
const chargedForm = (token: string) => `${token}${CHARGED_SUFFIX}`;

/** The row is still "processing" under the claim `token` (charged or not). */
const ownedBy = (candidateId: string, token: string) =>
  and(
    eq(candidates.id, candidateId),
    eq(candidates.status, "processing"),
    inArray(candidates.claimToken, [token, chargedForm(token)]),
  );

/** The claim a stored claim_token names, without the charge marker. null before the CV's first claim. */
export function claimGeneration(claimToken: string | null): string | null {
  return claimToken?.endsWith(CHARGED_SUFFIX) ? claimToken.slice(0, -CHARGED_SUFFIX.length) : claimToken;
}

/** What every claim writes. */
const claimedBy = (token: string) => ({
  status: "processing" as const,
  error: null,
  attempts: sql`${candidates.attempts} + 1`,
  claimToken: token,
  claimedAt: new Date(),
});

// ── Shared by both modes ──

/** Atomic claim: only one caller can move a row out of "pending". `token` then owns every later write. */
export async function claimPending(candidateId: string, token: string): Promise<Candidate | undefined> {
  const [candidate] = await db
    .update(candidates)
    .set(claimedBy(token))
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
export async function saveCvText(candidateId: string, token: string, cvText: string): Promise<boolean> {
  const rows = await db
    .update(candidates)
    .set({ cvText })
    .where(ownedBy(candidateId, token))
    .returning({ id: candidates.id });
  return rows.length > 0;
}

export type ReserveResult = "reserved" | "quota-reached" | "superseded";

/**
 * Counts this claim's analysis against the company's daily cap, in one statement: only while the row is still
 * claimed by `token` (a superseded or deleted CV costs nothing), and only once per claim (a retry finds the charge
 * marker and reports "reserved" again without counting). The candidate row is locked first, so a re-score or delete
 * can't land between the check and the charge.
 */
export async function reserveQuota(candidateId: string, token: string, now: Date = new Date()): Promise<ReserveResult> {
  const charged = chargedForm(token);
  const owned = db.$with("owned").as(
    db
      .select({ companyId: candidates.companyId, claimToken: candidates.claimToken })
      .from(candidates)
      .where(ownedBy(candidateId, token))
      .for("update"),
  );
  const charge = db.$with("charge").as(
    db
      .insert(aiUsage)
      .select(sql`select ${owned.companyId}, ${utcDay(now)}, 1 from ${owned} where ${owned.claimToken} = ${token}`)
      .onConflictDoUpdate(chargeOnConflict())
      .returning({ companyId: aiUsage.companyId }),
  );
  const mark = db.$with("mark").as(
    db
      .update(candidates)
      .set({ claimToken: charged })
      .where(and(eq(candidates.id, candidateId), eq(candidates.claimToken, token), sql`exists (select 1 from ${charge})`))
      .returning({ id: candidates.id }),
  );
  const [row] = await db
    .with(owned, charge, mark)
    .select({ claimToken: owned.claimToken, chargedNow: sql<boolean>`exists (select 1 from ${mark})` })
    .from(owned);
  if (!row) return "superseded";
  return row.claimToken === charged || row.chargedNow ? "reserved" : "quota-reached";
}

/**
 * Daily AI cap reached: back to pending (the extracted text is kept), and this claim doesn't count as an attempt.
 * The re-queue retries it once the UTC day rolls over.
 */
export async function releaseForQuota(candidateId: string, token: string): Promise<void> {
  await db
    .update(candidates)
    .set({ status: "pending", attempts: sql`${candidates.attempts} - 1` })
    .where(ownedBy(candidateId, token));
}

export type BusyReleaseResult = "requeued" | "gave-up" | "superseded";

/**
 * Every AI model was temporarily unavailable (overloaded, rate-limited, timing out): back to pending with a note for
 * the employer, so the re-queue tries again later, instead of failed. The claim doesn't count as an attempt, its
 * charge against the daily cap is given back, and `ai_retries` goes up by one. The MAX_AI_RETRIES-th time, the CV is
 * failed with the usual AI failure message instead (and that claim stays charged, as for any failed analysis).
 *
 * One statement, conditional on the claim like every write after it: the row is locked, and the refund happens only
 * when this claim was charged (`<token>:charged`) and the row was actually released. The release also drops the charge
 * marker (same claim generation, so the next event id is unchanged). A retry of this step, or a run that lost its
 * claim, finds the row no longer processing under `token` and gives back nothing, so a refund can't happen twice.
 */
export async function releaseForBusyAi(candidateId: string, token: string, now: Date = new Date()): Promise<BusyReleaseResult> {
  const owned = db.$with("owned").as(
    db
      .select({ companyId: candidates.companyId, claimToken: candidates.claimToken })
      .from(candidates)
      .where(ownedBy(candidateId, token))
      .for("update"),
  );
  const released = db.$with("released").as(
    db
      .update(candidates)
      .set({
        status: "pending",
        error: AI_BUSY_MESSAGE,
        attempts: sql`${candidates.attempts} - 1`,
        aiRetries: sql`${candidates.aiRetries} + 1`,
        claimToken: token,
      })
      // Intentional: `exists (owned)` looks redundant next to ownedBy, but it makes the lock (and the read of the old
      // claim token) happen before this update. A row this statement had already updated would be skipped by
      // owned's FOR UPDATE, and the CV would be released with no refund.
      .where(
        and(ownedBy(candidateId, token), lt(candidates.aiRetries, MAX_AI_RETRIES - 1), sql`exists (select 1 from ${owned})`),
      )
      .returning({ id: candidates.id }),
  );
  const refunded = db.$with("refunded").as(
    refundUsage(
      sql`(select ${owned.companyId} from ${owned} where ${owned.claimToken} = ${chargedForm(token)} and exists (select 1 from ${released}))`,
      now,
    ),
  );
  const [row] = await db
    .with(owned, released, refunded)
    .select({ released: sql<boolean>`exists (select 1 from ${released})` })
    .from(owned);
  if (!row) return "superseded";
  if (row.released) return "requeued";

  // Still claimed, but this was the last busy retry allowed.
  const failed = await db
    .update(candidates)
    .set({ status: "failed", error: new AiAnalysisError().message, aiRetries: sql`${candidates.aiRetries} + 1` })
    .where(ownedBy(candidateId, token))
    .returning({ id: candidates.id });
  return failed.length > 0 ? "gave-up" : "superseded";
}

/** Stores the analysis and marks the candidate ready. False when the claim was lost (nothing written). */
export async function saveAnalysis(
  candidateId: string,
  token: string,
  { analysis, provider, modelId }: AnalyzeResult,
): Promise<boolean> {
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
    .where(ownedBy(candidateId, token))
    .returning({ id: candidates.id });
  return rows.length > 0;
}

/** `message` must be employer-safe. False when the claim was lost (nothing written). */
export async function markFailed(candidateId: string, token: string, message: string): Promise<boolean> {
  const rows = await db
    .update(candidates)
    .set({ status: "failed", error: message })
    .where(ownedBy(candidateId, token))
    .returning({ id: candidates.id });
  return rows.length > 0;
}

// ── Durable (Inngest) steps. Each returns plain JSON: Inngest stores it as the step's result, beyond the reach of
// retention deletes, so a step must never return (or throw) the CV's text, profile, evaluation or contact details. ──

export type ClaimStepResult = { claimed: true; needsText: boolean } | { claimed: false; gaveUp: boolean };

/**
 * Claims the row for the run holding `token`. A row already "processing" is taken over too: runs are singletons per
 * candidate (a newer run cancels the older one), so it belongs to a cancelled run, to a run stuck since an outage
 * (re-sent by the re-queue cron), or to this run's own claim whose result was lost and is being retried. The new
 * token shuts out any write the old run still makes. Each claim counts an attempt; past MAX_ATTEMPTS the CV is
 * failed, so a file that kills the function every time can't loop forever.
 */
export async function claimStep(candidateId: string, token: string): Promise<ClaimStepResult> {
  const [row] = await db
    .update(candidates)
    .set(claimedBy(token))
    .where(and(eq(candidates.id, candidateId), inArray(candidates.status, ["pending", "processing"])))
    .returning({ attempts: candidates.attempts, hasText: sql<boolean>`${candidates.cvText} is not null` });
  if (!row) return { claimed: false, gaveUp: false };
  if (row.attempts > MAX_ATTEMPTS) {
    await markFailed(candidateId, token, GAVE_UP_MESSAGE);
    return { claimed: false, gaveUp: true };
  }
  return { claimed: true, needsText: !row.hasText };
}

export type ExtractStepResult = "ok" | "unreadable" | "superseded";

/** Extracts and stores the CV text (inline on serverless). Storage and DB errors throw, so the step is retried. */
export async function extractStep(candidateId: string, token: string): Promise<ExtractStepResult> {
  const [row] = await db
    .select({ cvFileKey: candidates.cvFileKey, hasText: sql<boolean>`${candidates.cvText} is not null` })
    .from(candidates)
    .where(ownedBy(candidateId, token))
    .limit(1);
  if (!row) return "superseded";
  if (row.hasText) return "ok";

  let cvText: string;
  try {
    cvText = await readCvText(row.cvFileKey);
  } catch (err) {
    if (!(err instanceof CvUnreadableError)) throw err;
    // Not retried: the same file gives the same result.
    return (await markFailed(candidateId, token, err.message)) ? "unreadable" : "superseded";
  }
  return (await saveCvText(candidateId, token, cvText)) ? "ok" : "superseded";
}

/** Charged only now, after extraction: an unreadable CV never uses up the company's daily cap. */
export async function reserveQuotaStep(candidateId: string, token: string): Promise<ReserveResult> {
  const reserved = await reserveQuota(candidateId, token);
  if (reserved === "quota-reached") await releaseForQuota(candidateId, token);
  return reserved;
}

/**
 * Why one model's step didn't save an analysis: a short code (see src/lib/ai/errors.ts), never the provider's message
 * (which can quote the prompt, and so the CV). "transient-…" codes mean the model was busy or out of reach.
 * "superseded": the claim was lost, so the run stops.
 */
export type AnalyzeFailure = "superseded" | AiFailureCode;
export type AnalyzeStepResult = { ok: true } | { ok: false; reason: AnalyzeFailure };

/**
 * One model of the fallback chain: calls the AI and saves its analysis in the same step, so the analysis never
 * becomes a step result. A failure is returned, not thrown, so the run moves on to the next model instead of Inngest
 * retrying this one.
 */
export async function analyzeStep(
  candidateId: string,
  token: string,
  provider: ResolvedProvider,
  { timeoutMs = PROVIDER_STEP_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<AnalyzeStepResult> {
  const [row] = await db
    .select({ cvText: candidates.cvText, job: jobs })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .where(ownedBy(candidateId, token))
    .limit(1);
  if (!row) return { ok: false, reason: "superseded" };
  // The claim step only skips extraction when the text exists, and nothing clears it.
  if (row.cvText == null) throw new Error(`Candidate ${candidateId} has no extracted text to analyze`);

  const attempt = await analyzeCvWithProvider({ cvText: row.cvText, job: row.job }, provider, { timeoutMs });
  // The reason (with the provider's message) has been logged; only its code may become the step result.
  if (!attempt.ok) return { ok: false, reason: attempt.code };
  return (await saveAnalysis(candidateId, token, attempt.result)) ? { ok: true } : { ok: false, reason: "superseded" };
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
  | "ai-busy"
  | "ai-failed";

/**
 * The Inngest process-cv run for one candidate: one step per unit of work, one step per model of the chain. `token` is
 * the run's id: its claim token, which the run's onFailure handler also knows. When every model was only busy, one
 * last step puts the CV back to pending (see releaseForBusyAi) and the run ends; the re-queue cron sends it again.
 */
export async function runProcessCvSteps(
  candidateId: string,
  token: string,
  step: StepRunner,
  chain: ResolvedProvider[] = resolveProviderChain().chain,
): Promise<ProcessCvOutcome> {
  // Intentional: with no AI provider the row isn't claimed. It stays pending, with no error, until a key is added;
  // the re-queue cron then picks it up.
  if (chain.length === 0) return "no-provider";

  const claim = await step.run("claim", () => claimStep(candidateId, token));
  if (!claim.claimed) return claim.gaveUp ? "gave-up" : "not-claimed";

  if (claim.needsText) {
    const extracted = await step.run("extract", () => extractStep(candidateId, token));
    if (extracted !== "ok") return extracted;
  }

  const quota = await step.run("reserve-quota", () => reserveQuotaStep(candidateId, token));
  if (quota !== "reserved") return quota;

  let allTransient = true;
  for (const [index, provider] of chain.entries()) {
    // The index keeps step ids unique: a provider can appear once per model.
    const attempt = await step.run(`analyze-${index}-${provider.id}`, () => analyzeStep(candidateId, token, provider));
    if (attempt.ok) return "ready";
    if (attempt.reason === "superseded") return "superseded";
    if (!isTransientAiFailure(attempt.reason)) allTransient = false;
  }

  if (allTransient) {
    const released = await step.run("release-busy-ai", () => releaseForBusyAi(candidateId, token));
    return released === "requeued" ? "ai-busy" : released === "gave-up" ? "ai-failed" : "superseded";
  }

  const failed = await step.run("mark-failed", () => markFailed(candidateId, token, new AiAnalysisError().message));
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
