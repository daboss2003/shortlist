import "server-only";
import { APICallError, NoObjectGeneratedError, Output, RetryError, generateText } from "ai";
import type { Job } from "@/db/schema";
import { buildAnalysisPrompt } from "@/lib/ai/prompt";
import { resolveProviderChain, type ResolvedProvider } from "@/lib/ai/providers";
import { cvAnalysisSchema, type CvAnalysis } from "@/lib/ai/schemas";
import type { AiProviderId } from "@/lib/ai/status";

/** No provider key in env. Message is safe to show to the employer. */
export class AiNotConfiguredError extends Error {}

/** Every configured provider failed. Message is short and safe to show to the employer. */
export class AiAnalysisError extends Error {}

export type AnalyzeResult = { analysis: CvAnalysis; provider: AiProviderId; modelId: string };

const TIMEOUT_MS = 120_000;
const MAX_LISTED = 5;

/** Extracts a profile and scores the CV against the job, trying each provider in order. */
export async function analyzeCv(
  input: { cvText: string; job: Job },
  chain: ResolvedProvider[] = resolveProviderChain().chain,
): Promise<AnalyzeResult> {
  if (chain.length === 0) {
    throw new AiNotConfiguredError(
      "No AI provider is configured. Add GEMINI_API_KEY (or another provider key) to the environment.",
    );
  }

  const { system, prompt } = buildAnalysisPrompt(input);
  const failures: string[] = [];

  for (const provider of chain) {
    try {
      // No `temperature`: some reasoning models reject it.
      const result = await generateText({
        model: provider.model,
        instructions: system,
        prompt,
        output: Output.object({ schema: cvAnalysisSchema, name: "cv_analysis" }),
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { analysis: sanitizeAnalysis(result.output), provider: provider.id, modelId: provider.modelId };
    } catch (err) {
      console.error(`[ai] ${provider.id} (${provider.modelId}) failed: ${clip(redact(errorMessage(err)), 500)}`);
      failures.push(`${provider.label}: ${clip(redact(shortReason(err)), 120)}`);
    }
  }

  throw new AiAnalysisError(clip(`AI analysis failed (${failures.join("; ")})`, 300));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortReason(err: unknown): string {
  if (RetryError.isInstance(err)) return shortReason(err.lastError);
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `timed out after ${TIMEOUT_MS / 1000}s`;
  }
  if (NoObjectGeneratedError.isInstance(err)) return "the response didn't match the expected format";
  if (APICallError.isInstance(err) && err.statusCode) return `HTTP ${err.statusCode} ${err.message}`;
  return errorMessage(err);
}

/** Provider messages sometimes echo (masked) keys; never let anything key-shaped reach logs or the UI. */
function redact(text: string): string {
  return text.replace(/\b(?:sk|gsk|xai|pk|rk)[-_][\w*.-]{8,}|\bAIza[\w-]{20,}/g, "[redacted]");
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// ── Post-processing: the model output is untrusted (the CV may contain prompt injection). ──

function sanitizeAnalysis({ profile, evaluation }: CvAnalysis): CvAnalysis {
  const matchedSkills = cleanList(evaluation.matchedSkills);
  const matched = new Set(matchedSkills.map((s) => s.toLowerCase()));

  return {
    profile: {
      fullName: cleanText(profile.fullName),
      email: cleanEmail(profile.email),
      phone: cleanText(profile.phone),
      location: cleanText(profile.location),
      headline: cleanText(profile.headline),
      summary: cleanText(profile.summary),
      totalExperienceYears:
        profile.totalExperienceYears != null && Number.isFinite(profile.totalExperienceYears) && profile.totalExperienceYears >= 0
          ? Math.round(profile.totalExperienceYears * 10) / 10
          : null,
      skills: cleanList(profile.skills),
      experience: profile.experience.map((e) => ({
        title: e.title.trim(),
        company: e.company.trim(),
        startDate: cleanText(e.startDate),
        endDate: cleanText(e.endDate),
        description: cleanText(e.description),
      })),
      education: profile.education.map((e) => ({
        institution: e.institution.trim(),
        degree: cleanText(e.degree),
        field: cleanText(e.field),
        graduationYear: cleanText(e.graduationYear),
      })),
      certifications: cleanList(profile.certifications),
      languages: cleanList(profile.languages),
      links: cleanList(profile.links.map(normalizeLink).filter((l): l is string => l !== null)),
    },
    evaluation: {
      overallScore: clampScore(evaluation.overallScore),
      skillsScore: clampScore(evaluation.skillsScore),
      experienceScore: clampScore(evaluation.experienceScore),
      educationScore: clampScore(evaluation.educationScore),
      matchedSkills,
      // A skill can't be both matched and missing.
      missingSkills: cleanList(evaluation.missingSkills).filter((s) => !matched.has(s.toLowerCase())),
      strengths: cleanList(evaluation.strengths).slice(0, MAX_LISTED),
      concerns: cleanList(evaluation.concerns).slice(0, MAX_LISTED),
      summary: evaluation.summary.trim(),
      recommendation: evaluation.recommendation,
    },
  };
}

function clampScore(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}

function cleanText(value: string | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Trimmed, empties dropped, deduped case-insensitively (first spelling wins). */
function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function cleanEmail(value: string | null): string | null {
  const v = value?.trim().toLowerCase();
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** http(s) URLs only; bare domains get https://. Drops javascript:, data:, mailto:, credentials and hostless junk. */
function normalizeLink(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // A scheme is "word:" not followed by a digit, so "github.com:443/x" still counts as a bare domain.
  const hasScheme = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(value);
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `https://${value.replace(/^\/+/, "")}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname.includes(".")) return null;
  return url.href;
}
