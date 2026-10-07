import { z } from "zod";

// Shared input rules for zod schemas at the request boundary.

export const INVALID_CHARACTER = "Contains an invalid character.";

/** Postgres rejects NUL (U+0000) in text (error 22021), so it must never reach a query. */
export const hasNul = (value: string) => value.includes("\u0000");

/**
 * A string that Postgres can store: NUL is a field error instead of a failed query (a 500). Use it in place of
 * `z.string()` for every free-text field that reaches the database; chain `.trim()`, `.min()` etc. as usual.
 */
export function safeText(params?: Parameters<typeof z.string>[0]) {
  return z.string(params).refine((value) => !hasNul(value), INVALID_CHARACTER);
}
