import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { aiFailureCode, isTransientAiFailure } from "./errors";

const apiError = (statusCode: number | undefined, message = "error", extra: Partial<{ isRetryable: boolean; cause: unknown }> = {}) =>
  new APICallError({
    message,
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
    requestBodyValues: {},
    statusCode,
    ...extra,
  });

const retried = (...errors: unknown[]) =>
  new RetryError({ message: `Failed after ${errors.length} attempts.`, reason: "maxRetriesExceeded", errors });

describe("aiFailureCode", () => {
  it.each([408, 409, 425, 429, 500, 502, 503, 504, 529])("treats HTTP %s as transient", (status) => {
    const code = aiFailureCode(apiError(status));
    expect(code).toBe(`transient-${status}`);
    expect(isTransientAiFailure(code)).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422, 501])("treats HTTP %s as permanent", (status) => {
    const code = aiFailureCode(apiError(status));
    expect(code).toBe(`http-${status}`);
    expect(isTransientAiFailure(code)).toBe(false);
  });

  it("goes by the status, not the wording, when there is one", () => {
    // A model that doesn't exist for this key stays failed, whatever the message says.
    expect(aiFailureCode(apiError(404, "models/gemini-9 is unavailable or not found"))).toBe("http-404");
    expect(aiFailureCode(apiError(503, "Bad request"))).toBe("transient-503");
  });

  it("classifies the AI SDK's RetryError by its last error", () => {
    // What the user saw: three 503 "high demand" answers, then "Failed after 3 attempts".
    const busy = apiError(503, "This model is currently experiencing high demand. Please try again later.");
    expect(aiFailureCode(retried(busy, busy, busy))).toBe("transient-503");
    expect(aiFailureCode(retried(busy, busy, apiError(400)))).toBe("http-400");
    expect(aiFailureCode(retried(apiError(400), busy))).toBe("transient-503");
    expect(aiFailureCode(retried(retried(busy)))).toBe("transient-503");
  });

  it("treats our timeout and an abort as transient", () => {
    expect(aiFailureCode(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(
      "transient-timeout",
    );
    expect(aiFailureCode(new DOMException("This operation was aborted", "AbortError"))).toBe("transient-timeout");
    expect(aiFailureCode(retried(apiError(503), new DOMException("timeout", "TimeoutError")))).toBe("transient-timeout");
  });

  it("treats network failures as transient", () => {
    // How the AI SDK reports a request that never got an answer.
    expect(aiFailureCode(apiError(undefined, "Cannot connect to API: other side closed", { isRetryable: true }))).toBe(
      "transient-network",
    );
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(aiFailureCode(reset)).toBe("transient-network");
    expect(aiFailureCode(new TypeError("fetch failed", { cause: reset }))).toBe("transient-network");
    expect(aiFailureCode(new TypeError("fetch failed"))).toBe("transient-network");
    expect(aiFailureCode(new Error("request failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }) }))).toBe(
      "transient-network",
    );
  });

  it.each([
    "upstream overloaded",
    "Overloaded",
    "This model is currently experiencing high demand.",
    "Rate limit reached for requests",
    "rate_limit_exceeded",
    "Service Unavailable",
  ])("treats a status-less %j as transient", (message) => {
    expect(aiFailureCode(new Error(message))).toBe("transient-busy");
  });

  it("treats everything else as permanent", () => {
    const invalid = new NoObjectGeneratedError({
      message: "No object generated: response did not match schema.",
      response: { id: "r", timestamp: new Date(0), modelId: "m" },
      usage: {
        inputTokens: undefined,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
      },
      finishReason: "stop",
    });
    expect(aiFailureCode(invalid)).toBe("invalid-output");
    expect(aiFailureCode(new Error("bad key sk-proj-abcdefghijklmnop"))).toBe("provider-error");
    expect(aiFailureCode(new Error("quota exceeded"))).toBe("provider-error");
    expect(aiFailureCode(apiError(undefined, "Invalid JSON response", { isRetryable: false }))).toBe("provider-error");
    expect(aiFailureCode("a string")).toBe("provider-error");
    expect(aiFailureCode(undefined)).toBe("provider-error");
  });
});
