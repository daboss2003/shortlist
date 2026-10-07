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

/** Reads provider config from env (no network). Gemini is the default primary when its key is present. */
export function resolveProviderChain(env: ProviderEnv = process.env): { chain: ResolvedProvider[]; error: string | null } {
  const configured = PROVIDER_ORDER.map((id) => buildProvider(id, env)).filter((p): p is ResolvedProvider => p !== null);

  let error: string | null = null;
  let primary: ResolvedProvider | undefined = configured[0];

  const requested = read(env, "AI_PROVIDER");
  if (requested) {
    const id = toProviderId(requested);
    if (!id) {
      error = `AI_PROVIDER is "${requested}", which isn't a supported provider. Use one of: ${PROVIDER_ORDER.join(", ")}.`;
    } else {
      const match = configured.find((p) => p.id === id);
      if (match) primary = match;
      else error = `AI_PROVIDER is "${requested}" but ${MISSING_CREDENTIALS[id]}`;
    }
  }

  if (!primary) return { chain: [], error };
  if (read(env, "AI_FALLBACK")?.toLowerCase() === "false") return { chain: [primary], error };
  return { chain: [primary, ...configured.filter((p) => p !== primary)], error };
}

function buildProvider(id: AiProviderId, env: ProviderEnv): ResolvedProvider | null {
  const make = (modelId: string, model: LanguageModel): ResolvedProvider => ({ id, label: AI_PROVIDER_LABELS[id], modelId, model });

  switch (id) {
    case "gemini": {
      const apiKey = read(env, "GEMINI_API_KEY") ?? read(env, "GOOGLE_GENERATIVE_AI_API_KEY");
      if (!apiKey) return null;
      const modelId = read(env, "GEMINI_MODEL") ?? "gemini-3.8-flash";
      return make(modelId, createGoogle({ apiKey })(modelId));
    }
    case "openai": {
      const apiKey = read(env, "OPENAI_API_KEY");
      if (!apiKey) return null;
      const modelId = read(env, "OPENAI_MODEL") ?? "gpt-5.4-mini";
      return make(modelId, createOpenAI({ apiKey })(modelId));
    }
    case "anthropic": {
      const apiKey = read(env, "ANTHROPIC_API_KEY");
      if (!apiKey) return null;
      const modelId = read(env, "ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
      return make(modelId, createAnthropic({ apiKey })(modelId));
    }
    case "groq": {
      const apiKey = read(env, "GROQ_API_KEY");
      if (!apiKey) return null;
      const modelId = read(env, "GROQ_MODEL") ?? "openai/gpt-oss-120b";
      return make(modelId, createGroq({ apiKey })(modelId));
    }
    case "openai-compatible": {
      const baseURL = read(env, "OPENAI_COMPATIBLE_BASE_URL");
      const modelId = read(env, "OPENAI_COMPATIBLE_MODEL");
      if (!baseURL || !modelId) return null;
      // Intentional: "" rather than undefined when no key is set (e.g. Ollama). Undefined makes the OpenAI
      // SDK fall back to OPENAI_API_KEY, which would send the real OpenAI key to this third-party server.
      const apiKey = read(env, "OPENAI_COMPATIBLE_API_KEY") ?? "";
      // Chat Completions, not Responses: most OpenAI-compatible servers only implement the former.
      return make(modelId, createOpenAI({ baseURL, apiKey, name: "openai-compatible" }).chat(modelId));
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
