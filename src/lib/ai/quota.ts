import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiUsage } from "@/db/schema";

// CONTRACT (frozen) — implemented by the pipeline workstream. Per-company daily cap on AI analyses
// (each pipeline run that calls the AI counts once, re-scores included). AI_DAILY_LIMIT: default 500;
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

/** Atomically counts one analysis against today's cap. Returns false (and counts nothing) when the cap is reached. */
export async function tryReserveAnalysis(companyId: string, now: Date = new Date()): Promise<boolean> {
  const limit = dailyLimit();
  // One statement, so concurrent reservations can't both take the last slot: the conflicting row is locked and the
  // WHERE re-checked against its latest value. A row comes back only when one was inserted or incremented.
  // Unlimited still counts usage.
  const rows = await db
    .insert(aiUsage)
    .values({ companyId, day: utcDay(now), analyses: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.companyId, aiUsage.day],
      set: { analyses: sql`${aiUsage.analyses} + 1` },
      setWhere: limit == null ? undefined : sql`${aiUsage.analyses} < ${limit}`,
    })
    .returning({ analyses: aiUsage.analyses });
  return rows.length > 0;
}
