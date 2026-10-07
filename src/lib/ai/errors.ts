import { APICallError, NoObjectGeneratedError, RetryError } from "ai";

// Why one call to one model failed, as a short code that never carries the provider's text (which can quote the
// prompt, and so the CV): safe for logs and Inngest step results. A "transient-…" code means the model was busy or
// out of reach and the same request may well work later; anything else will fail the same way again.

/** Timeouts, conflicts, rate limits, overload and gateway errors. 529 is Anthropic's "overloaded". */
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Provider wording for overload or rate limiting, for errors that carry no HTTP status. */
const BUSY_WORDING = /overloaded|high demand|rate[\s_-]?limit|unavailable/i;

/** Socket-level failures (Node, undici and Bun codes): the request never got an answer. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
]);

const FETCH_FAILED = new Set(["fetch failed", "failed to fetch"]);

export type TransientAiFailure = `transient-${number}` | "transient-timeout" | "transient-network" | "transient-busy";
export type PermanentAiFailure = `http-${number}` | "invalid-output" | "provider-error";
export type AiFailureCode = TransientAiFailure | PermanentAiFailure;

/** True for a code from `aiFailureCode` that means "try again later". */
export function isTransientAiFailure(code: string): code is TransientAiFailure {
  return code.startsWith("transient-");
}

/**
 * Classifies an error thrown by `generateText`. The AI SDK's own retries end in a RetryError: its last error decides.
 * An HTTP status, when there is one, always wins over the wording, so a 400/401/403/404 (bad request, bad key, a model
 * this key can't use) is permanent whatever its message says.
 */
export function aiFailureCode(err: unknown): AiFailureCode {
  let error = err;
  for (let depth = 0; RetryError.isInstance(error) && error.lastError !== undefined && depth < 5; depth++) {
    error = error.lastError;
  }

  if (isAbort(error)) return "transient-timeout";
  if (NoObjectGeneratedError.isInstance(error)) return "invalid-output";
  if (APICallError.isInstance(error) && error.statusCode) {
    return TRANSIENT_STATUSES.has(error.statusCode) ? `transient-${error.statusCode}` : `http-${error.statusCode}`;
  }
  if (isNetworkError(error)) return "transient-network";
  if (BUSY_WORDING.test(error instanceof Error ? error.message : String(error))) return "transient-busy";
  return "provider-error";
}

/** Our own timeout (AbortSignal.timeout) or an abort; also how a fetch reports either. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || err.name === "ResponseAborted");
}

/**
 * The request never got an HTTP answer: the AI SDK reports that as an APICallError with no status that it marks
 * retryable ("Cannot connect to API"), or the raw fetch/socket error surfaces, possibly as the cause of another.
 */
function isNetworkError(err: unknown): boolean {
  if (APICallError.isInstance(err) && err.statusCode == null && err.isRetryable) return true;
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
    if (current instanceof TypeError && FETCH_FAILED.has(current.message.toLowerCase())) return true;
    current = current.cause;
  }
  return false;
}
