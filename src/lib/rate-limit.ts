// Fixed-window rate limiter.
// Intentional: in-memory and per-process — this app runs as a single Node process on SQLite.
// Move to a shared store (Redis, DB) if it is ever scaled to multiple instances.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export type RateLimitResult = { ok: boolean; retryAfterSec: number };

function sweep(now: number) {
  if (now - lastSweep > 60_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    lastSweep = now;
  }
}

function liveBucket(key: string, now: number): Bucket | undefined {
  const bucket = buckets.get(key);
  return bucket && bucket.resetAt > now ? bucket : undefined;
}

/** Counts one call and reports whether it is within `limit` calls per window. */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const count = hit(key, windowMs, now);
  return count <= limit
    ? { ok: true, retryAfterSec: 0 }
    : { ok: false, retryAfterSec: Math.ceil((buckets.get(key)!.resetAt - now) / 1000) };
}

/** Whether one more hit is allowed (fewer than `limit` recorded this window). Counts nothing. */
export function peek(key: string, limit: number, now = Date.now()): RateLimitResult {
  const bucket = liveBucket(key, now);
  return !bucket || bucket.count < limit
    ? { ok: true, retryAfterSec: 0 }
    : { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
}

/** Records one hit, starting a new window if none is running. Returns the count in the current window. */
export function hit(key: string, windowMs: number, now = Date.now()): number {
  sweep(now);
  const bucket = liveBucket(key, now);
  if (!bucket) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  bucket.count += 1;
  return bucket.count;
}

/** Takes back one hit recorded by `hit` in the current window (e.g. the attempt turned out to be legitimate). */
export function refund(key: string, now = Date.now()): void {
  const bucket = liveBucket(key, now);
  if (bucket && bucket.count > 0) bucket.count -= 1;
}

/** Test helper. */
export function resetRateLimits(): void {
  buckets.clear();
}
