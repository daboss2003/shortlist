import "server-only";
import { and, eq, gt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { aiUsage } from "@/db/schema";

// CONTRACT (frozen) — implemented by the pipeline workstream. Per-company daily cap on AI analyses
// (each claim of a CV that reaches the AI counts once, re-scores included). AI_DAILY_LIMIT: default 500;
// 0 (or negative) = unlimited. Days are UTC. Backed by the `ai_usage` table.

export type AiQuota = {
  used: number;
  /** null = unlimited. */
  limit: number | null;
  /** null = unlimited. */
  remaining: number | null;
  /** Start of the next UTC day. */
  resetsAt: Date;
};

const DEFAULT_DAILY_LIMIT = 500;

/** AI_DAILY_LIMIT as a positive integer, null for unlimited (0 or negative). Unset or not an integer: the default. */
export function dailyLimit(): number | null {
  const raw = process.env.AI_DAILY_LIMIT?.trim();
  if (!raw || !/^-?\d{1,9}$/.test(raw)) return DEFAULT_DAILY_LIMIT;
  const limit = Number(raw);
  return limit <= 0 ? null : limit;
}

/** The ai_usage.day key (YYYY-MM-DD, UTC) for `now`. */
export const utcDay = (now: Date) => now.toISOString().slice(0, 10);
const nextUtcMidnight = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

export async function getAiQuota(companyId: string, now: Date = new Date()): Promise<AiQuota> {
  const limit = dailyLimit();
  const [row] = await db
    .select({ analyses: aiUsage.analyses })
    .from(aiUsage)
    .where(and(eq(aiUsage.companyId, companyId), eq(aiUsage.day, utcDay(now))))
    .limit(1);
  const used = row?.analyses ?? 0;
  return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used), resetsAt: nextUtcMidnight(now) };
}

/**
 * The conflict clause of every charge (an INSERT of `analyses: 1` into ai_usage): one more analysis, only while
 * under today's cap. In one statement, concurrent charges can't both take the last slot: the conflicting row is
 * locked and the WHERE re-checked against its latest value. A row is returned only when one was inserted or
 * incremented. Unlimited still counts usage.
 */
export function chargeOnConflict(limit: number | null = dailyLimit()) {
  return {
    target: [aiUsage.companyId, aiUsage.day],
    set: { analyses: sql`${aiUsage.analyses} + 1` },
    setWhere: limit == null ? undefined : sql`${aiUsage.analyses} < ${limit}`,
  };
}

/**
 * Atomically counts one analysis against today's cap. Returns false (and counts nothing) when the cap is reached.
 * The pipeline charges through `reserveQuota` (src/lib/pipeline/steps.ts) instead, which also ties the charge to
 * the CV's claim.
 */
export async function tryReserveAnalysis(companyId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .insert(aiUsage)
    .values({ companyId, day: utcDay(now), analyses: 1 })
    .onConflictDoUpdate(chargeOnConflict())
    .returning({ analyses: aiUsage.analyses });
  return rows.length > 0;
}

/**
 * The UPDATE behind every refund: one analysis off `companyId`'s count for the UTC day of `now`, only while that count
 * is above 0, so a refund can never take it negative. Returns a row only when something was taken off. `companyId`
 * may be a subquery, so the pipeline can run this inside the statement that releases a claim (releaseForBusyAi in
 * src/lib/pipeline/steps.ts).
 */
export function refundUsage(companyId: string | SQL, now: Date) {
  return db
    .update(aiUsage)
    .set({ analyses: sql`${aiUsage.analyses} - 1` })
    .where(and(eq(aiUsage.companyId, companyId), eq(aiUsage.day, utcDay(now)), gt(aiUsage.analyses, 0)))
    .returning({ analyses: aiUsage.analyses });
}

/**
 * Gives back one analysis of today's count (never below 0), for an analysis that was charged but never ran. Returns
 * false when there was nothing to give back. Like tryReserveAnalysis, the pipeline doesn't call this directly: it
 * refunds through releaseForBusyAi, which ties the refund to the claim's charge so it can't happen twice.
 * Intentional: "today" is the day of the refund, not of the charge; the charge's day isn't recorded, and the two
 * differ only for a claim that spans midnight UTC.
 */
export async function refundAnalysis(companyId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await refundUsage(companyId, now);
  return rows.length > 0;
}
