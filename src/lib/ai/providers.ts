import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AiProviderId, AiProviderInfo } from "@/lib/ai/status";
import { AI_PROVIDER_LABELS } from "@/lib/format";

export type ProviderEnv = Record<string, string | undefined>;
export type ResolvedProvider = AiProviderInfo & { model: LanguageModel };

const PROVIDER_ORDER: AiProviderId[] = ["gemini", "openai", "anthropic", "groq", "openai-compatible"];

const ALIASES: Record<string, AiProviderId> = { google: "gemini", claude: "anthropic" };

const MISSING_CREDENTIALS: Record<AiProviderId, string> = {
  gemini: "GEMINI_API_KEY is not set",
  openai: "OPENAI_API_KEY is not set",
  anthropic: "ANTHROPIC_API_KEY is not set",
  groq: "GROQ_API_KEY is not set",
  "openai-compatible": "OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL are not both set",
};

/** Used when `GEMINI_MODEL` is unset. Flash-Lite has its own capacity, so it often answers while Flash is overloaded. */
export const DEFAULT_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];

/**
 * Reads provider config from env (no network). Gemini is the default primary when its key is present. Each
 * `<PROVIDER>_MODEL` may list several models (comma-separated), so the chain has one entry per model, provider-major:
 * the primary provider's models in order, then each fallback provider's. AI_FALLBACK=false keeps only the first entry.
 */
export function resolveProviderChain(env: ProviderEnv = process.env): { chain: ResolvedProvider[]; error: string | null } {
  const configured = PROVIDER_ORDER.map((id) => buildProvider(id, env)).filter((models) => models.length > 0);

  let error: string | null = null;
  let primary: ResolvedProvider[] | undefined = configured[0];

  const requested = read(env, "AI_PROVIDER");
  if (requested) {
    const id = toProviderId(requested);
    if (!id) {
      error = `AI_PROVIDER is "${requested}", which isn't a supported provider. Use one of: ${PROVIDER_ORDER.join(", ")}.`;
    } else {
      const match = configured.find((models) => models[0].id === id);
      if (match) primary = match;
      else error = `AI_PROVIDER is "${requested}" but ${MISSING_CREDENTIALS[id]}`;
    }
  }

  if (!primary) return { chain: [], error };
  if (read(env, "AI_FALLBACK")?.toLowerCase() === "false") return { chain: [primary[0]], error };
  return { chain: [...primary, ...configured.filter((models) => models !== primary).flat()], error };
}

/**
 * A `<PROVIDER>_MODEL` value as a list of model ids: comma-separated, each trimmed, empty entries dropped, repeats
 * dropped (the first keeps its place).
 */
export function parseModelList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((model) => model.trim()).filter(Boolean))];
}

/** One chain entry per model the provider is configured with; none when it isn't configured. */
function buildProvider(id: AiProviderId, env: ProviderEnv): ResolvedProvider[] {
  const make = (modelIds: string[], model: (modelId: string) => LanguageModel): ResolvedProvider[] =>
    modelIds.map((modelId) => ({ id, label: AI_PROVIDER_LABELS[id], modelId, model: model(modelId) }));
  const models = (name: string, fallback: string[]) => {
    const listed = parseModelList(env[name]);
    return listed.length > 0 ? listed : fallback;
  };

  switch (id) {
    case "gemini": {
      const apiKey = read(env, "GEMINI_API_KEY") ?? read(env, "GOOGLE_GENERATIVE_AI_API_KEY");
      if (!apiKey) return [];
      return make(models("GEMINI_MODEL", DEFAULT_GEMINI_MODELS), createGoogle({ apiKey }));
    }
    case "openai": {
      const apiKey = read(env, "OPENAI_API_KEY");
      if (!apiKey) return [];
      return make(models("OPENAI_MODEL", ["gpt-5.4-mini"]), createOpenAI({ apiKey }));
    }
    case "anthropic": {
      const apiKey = read(env, "ANTHROPIC_API_KEY");
      if (!apiKey) return [];
      return make(models("ANTHROPIC_MODEL", ["claude-sonnet-5-5"]), createAnthropic({ apiKey }));
    }
    case "groq": {
      const apiKey = read(env, "GROQ_API_KEY");
      if (!apiKey) return [];
      return make(models("GROQ_MODEL", ["openai/gpt-oss-120b"]), createGroq({ apiKey }));
    }
    case "openai-compatible": {
      const baseURL = read(env, "OPENAI_COMPATIBLE_BASE_URL");
      const modelIds = parseModelList(env.OPENAI_COMPATIBLE_MODEL);
      if (!baseURL || modelIds.length === 0) return [];
      // Intentional: "" rather than undefined when no key is set (e.g. Ollama). Undefined makes the OpenAI
      // SDK fall back to OPENAI_API_KEY, which would send the real OpenAI key to this third-party server.
      const apiKey = read(env, "OPENAI_COMPATIBLE_API_KEY") ?? "";
      // Chat Completions, not Responses: most OpenAI-compatible servers only implement the former.
      const provider = createOpenAI({ baseURL, apiKey, name: "openai-compatible" });
      return make(modelIds, (modelId) => provider.chat(modelId));
    }
  }
}

function toProviderId(value: string): AiProviderId | null {
  const v = value.toLowerCase();
  if (ALIASES[v]) return ALIASES[v];
  return PROVIDER_ORDER.find((id) => id === v) ?? null;
}

/** Trimmed env value; empty or whitespace-only counts as unset. */
function read(env: ProviderEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}
