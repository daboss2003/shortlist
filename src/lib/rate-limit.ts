import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";

// Fixed-window rate limiter backed by the rate_limits table, so every serverless instance shares the counts
// (an in-memory map would be per-instance and trivially bypassed). Each hit is one atomic upsert.

export type RateLimitResult = { ok: boolean; retryAfterSec: number };

const OK: RateLimitResult = { ok: true, retryAfterSec: 0 };

/** Stored keys are sha256(key): fixed length, so long attacker input (emails, IPs) never becomes a key. */
const storedKey = (key: string) => createHash("sha256").update(key).digest("hex");

// Intentional: timestamps go into raw SQL as ISO strings with an explicit cast, so both drivers (Neon, PGlite)
// bind them the same way; a bare Date param is serialized differently by each.
const at = (date: Date) => sql`${date.toISOString()}::timestamptz`;

const blocked = (resetAt: Date, now: Date): RateLimitResult => ({
  ok: false,
  retryAfterSec: Math.ceil((resetAt.getTime() - now.getTime()) / 1000),
});

/** One atomic hit: starts a new window if the stored one has ended, else increments. */
async function record(key: string, windowMs: number, now: Date): Promise<{ count: number; resetAt: Date }> {
  const expired = sql`${rateLimits.resetAt} <= ${at(now)}`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key: storedKey(key), count: 1, resetAt: new Date(now.getTime() + windowMs) })
    .onConflictDoUpdate({
      target: rateLimits.key,
      // Both expressions read the row as it was before this statement, so they agree on whether it expired.
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${expired} then excluded.reset_at else ${rateLimits.resetAt} end`,
      },
    })
    .returning({ count: rateLimits.count, resetAt: rateLimits.resetAt });
  return row;
}

/** Counts one call and reports whether it is within `limit` calls per window. */
export async function rateLimit(key: string, limit: number, windowMs: number, now = new Date()): Promise<RateLimitResult> {
  const { count, resetAt } = await record(key, windowMs, now);
  return count <= limit ? OK : blocked(resetAt, now);
}

/** Whether one more hit is allowed (fewer than `limit` recorded this window). Counts nothing. */
export async function peek(key: string, limit: number, now = new Date()): Promise<RateLimitResult> {
  const [row] = await db
    .select({ count: rateLimits.count, resetAt: rateLimits.resetAt })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, storedKey(key)), gt(rateLimits.resetAt, now)))
    .limit(1);
  return !row || row.count < limit ? OK : blocked(row.resetAt, now);
}

/** Records one hit, starting a new window if none is running. Returns the count in the current window. */
export async function hit(key: string, windowMs: number, now = new Date()): Promise<number> {
  return (await record(key, windowMs, now)).count;
}

/** Takes back one hit recorded by `hit` in the current window (e.g. the attempt turned out to be legitimate). */
export async function refund(key: string, now = new Date()): Promise<void> {
  await db
    .update(rateLimits)
    .set({ count: sql`greatest(${rateLimits.count} - 1, 0)` })
    .where(and(eq(rateLimits.key, storedKey(key)), gt(rateLimits.resetAt, now), gt(rateLimits.count, 0)));
}

/** Deletes counters whose window has ended. Returns how many were removed. Run periodically (cron). */
export async function purgeExpiredRateLimits(now = new Date()): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(lte(rateLimits.resetAt, now))
    .returning({ key: rateLimits.key });
  return deleted.length;
}

/** Test helper. */
export async function resetRateLimits(): Promise<void> {
  await db.delete(rateLimits);
}
