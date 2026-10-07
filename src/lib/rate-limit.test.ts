import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { hit, peek, purgeExpiredRateLimits, rateLimit, refund, resetRateLimits } from "./rate-limit";

const at = (ms: number) => new Date(ms);

describe("rateLimit", () => {
  beforeEach(resetRateLimits);

  it("allows up to the limit within a window, then blocks with a retry hint", async () => {
    const t = 1_000_000;
    expect((await rateLimit("ip:1", 2, 60_000, at(t))).ok).toBe(true);
    expect((await rateLimit("ip:1", 2, 60_000, at(t + 1))).ok).toBe(true);
    expect(await rateLimit("ip:1", 2, 60_000, at(t + 2))).toEqual({ ok: false, retryAfterSec: 60 });
  });

  it("resets after the window and keeps keys independent", async () => {
    const t = 2_000_000;
    await rateLimit("ip:2", 1, 1000, at(t));
    expect((await rateLimit("ip:2", 1, 1000, at(t + 1))).ok).toBe(false);
    expect((await rateLimit("ip:3", 1, 1000, at(t + 1))).ok).toBe(true);
    expect((await rateLimit("ip:2", 1, 1000, at(t + 1000))).ok).toBe(true);
  });
});

describe("peek / hit / refund", () => {
  beforeEach(resetRateLimits);

  it("peek never counts", async () => {
    const t = 3_000_000;
    for (let i = 0; i < 100; i++) expect((await peek("k", 1, at(t))).ok).toBe(true);
    expect(await hit("k", 60_000, at(t))).toBe(1);
    expect((await peek("k", 2, at(t))).ok).toBe(true);
  });

  it("blocks once `limit` hits are recorded, with a retry hint, until the window ends", async () => {
    const t = 4_000_000;
    await hit("k", 60_000, at(t));
    await hit("k", 60_000, at(t + 1));
    expect(await peek("k", 2, at(t + 2))).toEqual({ ok: false, retryAfterSec: 60 });
    expect((await peek("k", 3, at(t + 2))).ok).toBe(true);
    expect((await peek("k", 2, at(t + 60_000))).ok).toBe(true);
    expect(await hit("k", 60_000, at(t + 60_000))).toBe(1);
  });

  it("refund takes back one hit and never goes below zero", async () => {
    const t = 5_000_000;
    await hit("k", 60_000, at(t));
    await hit("k", 60_000, at(t));
    await refund("k", at(t));
    expect((await peek("k", 2, at(t))).ok).toBe(true);
    await refund("k", at(t));
    await refund("k", at(t));
    expect(await hit("k", 60_000, at(t))).toBe(1);
    await refund("missing", at(t));
    expect((await peek("missing", 1, at(t))).ok).toBe(true);
  });

  it("refund does nothing once the window has ended", async () => {
    const t = 5_500_000;
    await hit("k", 1000, at(t));
    await hit("k", 1000, at(t));
    await refund("k", at(t + 1000));
    expect((await db.select({ count: rateLimits.count }).from(rateLimits))[0].count).toBe(2);
    expect(await hit("k", 1000, at(t + 1000))).toBe(1);
  });

  it("shares buckets with rateLimit", async () => {
    const t = 6_000_000;
    await rateLimit("k", 5, 60_000, at(t));
    expect(await hit("k", 60_000, at(t))).toBe(2);
  });

  it("counts concurrent hits atomically: 20 parallel hits get 1..20 with no duplicates", async () => {
    const t = 7_000_000;
    const counts = await Promise.all(Array.from({ length: 20 }, () => hit("burst", 60_000, at(t))));
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("lets exactly `limit` of a parallel burst through", async () => {
    const t = 7_500_000;
    const results = await Promise.all(Array.from({ length: 12 }, () => rateLimit("burst", 5, 60_000, at(t))));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });
});

describe("storage", () => {
  beforeEach(resetRateLimits);

  it("stores sha256(key), never the raw key, so long input can't bloat the table", async () => {
    const long = `login:${"x".repeat(10_000)}@example.com|203.0.113.1`;
    await hit(long, 60_000);
    const rows = await db.select().from(rateLimits);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(createHash("sha256").update(long).digest("hex"));
    expect(rows[0].key).toHaveLength(64);
  });

  it("purgeExpiredRateLimits deletes only ended windows", async () => {
    const t = 8_000_000;
    await hit("old", 1000, at(t));
    await hit("live", 60_000, at(t));
    expect(await purgeExpiredRateLimits(at(t + 1000))).toBe(1);
    expect(await db.select().from(rateLimits)).toHaveLength(1);
    expect(await hit("live", 60_000, at(t + 1000))).toBe(2);
    expect(await purgeExpiredRateLimits(at(t + 1000))).toBe(0);
  });
});
