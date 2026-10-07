// Fixed-window rate limiter.
// Intentional: in-memory and per-process — this app runs as a single Node process on SQLite.
// Move to a shared store (Redis, DB) if it is ever scaled to multiple instances.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export type RateLimitResult = { ok: boolean; retryAfterSec: number };

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (now - lastSweep > 60_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    lastSweep = now;
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  bucket.count += 1;
  return bucket.count <= limit
    ? { ok: true, retryAfterSec: 0 }
    : { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
}

/** Test helper. */
export function resetRateLimits(): void {
  buckets.clear();
}
