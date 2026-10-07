import "server-only";

// CONTRACT (frozen) — implemented by the AI/pipeline workstream. Used by the dashboard to show
// which AI is ranking candidates, or a setup warning when no provider key is configured.

export type AiProviderId = "gemini" | "openai" | "anthropic" | "groq" | "openai-compatible";

export type AiProviderInfo = { id: AiProviderId; label: string; modelId: string };

export type AiStatus = {
  /** Provider tried first, or null when nothing is configured. */
  primary: AiProviderInfo | null;
  /** Tried in order if the primary fails. */
  fallbacks: AiProviderInfo[];
  /** Human-readable misconfiguration message (e.g. AI_PROVIDER set without its key), else null. */
  error: string | null;
};

export function getAiStatus(): AiStatus {
  throw new Error("not implemented");
}
