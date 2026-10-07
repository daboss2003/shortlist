import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GEMINI_MODELS, parseModelList, resolveProviderChain, type ProviderEnv } from "./providers";
import { getAiStatus } from "./status";

const ids = (env: ProviderEnv) => resolveProviderChain(env).chain.map((p) => p.id);
const entries = (env: ProviderEnv) => resolveProviderChain(env).chain.map((p) => `${p.id}:${p.modelId}`);

const ALL_KEYS: ProviderEnv = {
  GEMINI_API_KEY: "g-key",
  OPENAI_API_KEY: "o-key",
  ANTHROPIC_API_KEY: "a-key",
  GROQ_API_KEY: "q-key",
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
  OPENAI_COMPATIBLE_MODEL: "llama3.3",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveProviderChain", () => {
  it("makes Gemini the primary when several keys are present, then falls back in canonical order", () => {
    const { chain, error } = resolveProviderChain({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
    expect(error).toBeNull();
    expect(chain.map(({ id, label, modelId }) => ({ id, label, modelId }))).toEqual([
      { id: "gemini", label: "Google Gemini", modelId: "gemini-3.8-flash" },
      { id: "gemini", label: "Google Gemini", modelId: "gemini-3.5-flash-lite" },
      { id: "openai", label: "OpenAI", modelId: "gpt-5.4-mini" },
      { id: "anthropic", label: "Anthropic Claude", modelId: "claude-sonnet-5-5" },
    ]);
    expect(ids(ALL_KEYS)).toEqual(["gemini", "gemini", "openai", "anthropic", "groq", "openai-compatible"]);
  });

  it("defaults Gemini to Flash, then Flash-Lite (separate capacity) when GEMINI_MODEL is unset or empty", () => {
    expect(DEFAULT_GEMINI_MODELS).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    expect(entries({ GEMINI_API_KEY: "g" })).toEqual(["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite"]);
    expect(entries({ GEMINI_API_KEY: "g", GEMINI_MODEL: " , ," })).toEqual([
      "gemini:gemini-3.8-flash",
      "gemini:gemini-3.5-flash-lite",
    ]);
    // A single model replaces the default list: no hidden fallback model.
    expect(entries({ GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-3.6-flash" })).toEqual(["gemini:gemini-3.6-flash"]);
  });

  it("uses AI_PROVIDER as the primary (trimmed, case-insensitive) and keeps the rest as fallbacks", () => {
    expect(ids({ ...ALL_KEYS, AI_PROVIDER: " Groq " })).toEqual([
      "groq",
      "gemini",
      "gemini",
      "openai",
      "anthropic",
      "openai-compatible",
    ]);
    expect(resolveProviderChain({ ...ALL_KEYS, AI_PROVIDER: "groq" }).error).toBeNull();
  });

  it("accepts the google and claude aliases", () => {
    expect(ids({ ...ALL_KEYS, AI_PROVIDER: "claude" })[0]).toBe("anthropic");
    expect(ids({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", AI_PROVIDER: "GOOGLE" })).toEqual(["gemini", "gemini", "openai"]);
  });

  it("reports AI_PROVIDER without its key and falls back to the configured providers", () => {
    const { chain, error } = resolveProviderChain({ AI_PROVIDER: "openai", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" });
    expect(error).toBe('AI_PROVIDER is "openai" but OPENAI_API_KEY is not set');
    expect(chain.map((p) => p.id)).toEqual(["gemini", "gemini", "groq"]);
  });

  it("reports an unknown AI_PROVIDER", () => {
    const { chain, error } = resolveProviderChain({ AI_PROVIDER: "mistral", OPENAI_API_KEY: "o" });
    expect(error).toMatch(/AI_PROVIDER is "mistral"/);
    expect(error).toMatch(/gemini, openai, anthropic, groq, openai-compatible/);
    expect(chain.map((p) => p.id)).toEqual(["openai"]);
  });

  it("returns an empty chain and no error when nothing is configured", () => {
    expect(resolveProviderChain({})).toEqual({ chain: [], error: null });
    // Whitespace-only values count as unset.
    expect(resolveProviderChain({ GEMINI_API_KEY: "   ", OPENAI_API_KEY: "" })).toEqual({ chain: [], error: null });
  });

  it("uses only the primary provider's first model when AI_FALLBACK=false", () => {
    expect(entries({ ...ALL_KEYS, AI_FALLBACK: "false" })).toEqual(["gemini:gemini-3.8-flash"]);
    expect(entries({ ...ALL_KEYS, AI_FALLBACK: "FALSE", GEMINI_MODEL: "gemini-b, gemini-a" })).toEqual(["gemini:gemini-b"]);
    expect(entries({ ...ALL_KEYS, AI_FALLBACK: "false", AI_PROVIDER: "anthropic", ANTHROPIC_MODEL: "c1,c2" })).toEqual([
      "anthropic:c1",
    ]);
    expect(ids({ ...ALL_KEYS, AI_FALLBACK: "true" })).toHaveLength(6);
  });

  it("expands every model list into one entry per model, the primary provider's models first", () => {
    const env = {
      ...ALL_KEYS,
      GEMINI_MODEL: "g1,g2",
      OPENAI_MODEL: "o1, o2 ,o3",
      ANTHROPIC_MODEL: "a1",
      GROQ_MODEL: "q1,q2",
      OPENAI_COMPATIBLE_MODEL: "c1,c2",
    };
    expect(entries(env)).toEqual([
      "gemini:g1",
      "gemini:g2",
      "openai:o1",
      "openai:o2",
      "openai:o3",
      "anthropic:a1",
      "groq:q1",
      "groq:q2",
      "openai-compatible:c1",
      "openai-compatible:c2",
    ]);
    expect(entries({ ...env, AI_PROVIDER: "groq" })).toEqual([
      "groq:q1",
      "groq:q2",
      "gemini:g1",
      "gemini:g2",
      "openai:o1",
      "openai:o2",
      "openai:o3",
      "anthropic:a1",
      "openai-compatible:c1",
      "openai-compatible:c2",
    ]);
    // Each entry is its own model instance, for its own model id.
    const { chain } = resolveProviderChain(env);
    expect(chain.map((p) => (p.model as { modelId: string }).modelId)).toEqual(chain.map((p) => p.modelId));
  });

  it("an OPENAI_COMPATIBLE_MODEL list with no model in it leaves that provider unconfigured", () => {
    expect(ids({ OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1", OPENAI_COMPATIBLE_MODEL: " , " })).toEqual([]);
  });

  it("applies model env overrides", () => {
    const { chain } = resolveProviderChain({
      ...ALL_KEYS,
      GEMINI_MODEL: "gemini-custom",
      OPENAI_MODEL: "gpt-custom",
      ANTHROPIC_MODEL: "claude-custom",
      GROQ_MODEL: "groq-custom",
      OPENAI_COMPATIBLE_MODEL: "deepseek-chat",
    });
    expect(chain.map((p) => p.modelId)).toEqual(["gemini-custom", "gpt-custom", "claude-custom", "groq-custom", "deepseek-chat"]);
    expect(chain.map((p) => (p.model as { modelId: string }).modelId)).toEqual([
      "gemini-custom",
      "gpt-custom",
      "claude-custom",
      "groq-custom",
      "deepseek-chat",
    ]);
  });

  it("accepts GOOGLE_GENERATIVE_AI_API_KEY for Gemini", () => {
    expect(ids({ GOOGLE_GENERATIVE_AI_API_KEY: "g" })).toEqual(["gemini", "gemini"]);
  });

  it("requires both base URL and model for openai-compatible; the API key is optional", () => {
    expect(ids({ OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1" })).toEqual([]);
    expect(ids({ OPENAI_COMPATIBLE_MODEL: "llama3.3" })).toEqual([]);
    expect(ids({ OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1", OPENAI_COMPATIBLE_MODEL: "llama3.3" })).toEqual([
      "openai-compatible",
    ]);
    expect(resolveProviderChain({ AI_PROVIDER: "openai-compatible", OPENAI_COMPATIBLE_MODEL: "m" }).error).toMatch(
      /OPENAI_COMPATIBLE_BASE_URL/,
    );
  });

  it("sends openai-compatible requests to the chat-completions endpoint without leaking OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-real-openai-key");
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "llama3.3",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [provider] = resolveProviderChain({
      OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1/",
      OPENAI_COMPATIBLE_MODEL: "llama3.3",
    }).chain;
    const { text } = await generateText({ model: provider.model, prompt: "hi", maxRetries: 0 });

    expect(text).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(JSON.stringify(init.headers)).not.toContain("sk-real-openai-key");
  });
});

describe("parseModelList", () => {
  it("splits on commas, trims, drops empty entries and repeats (first wins)", () => {
    expect(parseModelList("a,b")).toEqual(["a", "b"]);
    expect(parseModelList("  a ,, b ,a, ,c,b  ")).toEqual(["a", "b", "c"]);
    expect(parseModelList("openai/gpt-oss-120b")).toEqual(["openai/gpt-oss-120b"]);
    expect(parseModelList(" , ")).toEqual([]);
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList(undefined)).toEqual([]);
  });

  it("dedupes within a provider's chain entries", () => {
    expect(entries({ GEMINI_API_KEY: "g", GEMINI_MODEL: "x, y, x ,y" })).toEqual(["gemini:x", "gemini:y"]);
  });
});

describe("getAiStatus", () => {
  it("describes the chain from process.env without exposing model instances", () => {
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("OPENAI_API_KEY", "o");
    vi.stubEnv("AI_FALLBACK", "true");
    const status = getAiStatus();
    expect(status.primary).toEqual({ id: "gemini", label: "Google Gemini", modelId: "gemini-3.8-flash" });
    expect(status.fallbacks.map((p) => `${p.id}:${p.modelId}`)).toEqual(["gemini:gemini-3.5-flash-lite", "openai:gpt-5.4-mini"]);
    expect(status.error).toBeNull();
    expect(Object.keys(status.primary!).sort()).toEqual(["id", "label", "modelId"]);
  });

  it("reports nothing configured", () => {
    expect(getAiStatus()).toEqual({ primary: null, fallbacks: [], error: null });
  });
});
