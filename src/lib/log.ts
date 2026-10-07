import { DrizzleQueryError } from "drizzle-orm";

// Drizzle puts a failed query's SQL *and its parameters* in the error message, and so in its stack: CV text, emails,
// profile JSON, password hashes. Those must never reach logs, or Inngest (which stores a failed step's error).

const DB_FAILURE = "database query failed";

function isQueryError(err: unknown): boolean {
  // Also by its message: a second copy of drizzle-orm in node_modules would fail the instanceof check. (Not by its
  // `query`/`params` fields: drivers' own errors have those too, with a message that is just the database's.)
  return err instanceof DrizzleQueryError || (err instanceof Error && err.message.startsWith("Failed query: "));
}

/** The first query error in `err`'s cause chain, if any. */
function findQueryError(err: unknown): Error | null {
  for (let e = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (isQueryError(e)) return e as Error;
  }
  return null;
}

/**
 * Text that is safe to log for any error. For a failed query, only the database driver's own message (never
 * drizzle's message, its params or its stack). For anything else, the stack when `withStack` is set, else the message.
 */
export function describeError(err: unknown, { withStack = false }: { withStack?: boolean } = {}): string {
  const queryError = findQueryError(err);
  if (queryError) {
    const cause = queryError.cause;
    return cause instanceof Error && !isQueryError(cause) && cause.message ? `${DB_FAILURE}: ${cause.message}` : DB_FAILURE;
  }
  if (err instanceof Error) return (withStack && err.stack) || err.message;
  return String(err);
}

/**
 * Runs `fn`, rethrowing a failed query as a plain Error carrying only `describeError`'s text. Other errors pass
 * through untouched. For work whose errors leave this process (an Inngest step's error is stored by Inngest).
 */
export async function withSafeErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (findQueryError(err)) throw new Error(describeError(err));
    throw err;
  }
}
