import { beforeEach, describe, expect, it } from "vitest";
import { hit, peek, rateLimit, refund, resetRateLimits } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(resetRateLimits);

  it("allows up to the limit within a window, then blocks with a retry hint", () => {
    const t = 1_000_000;
    expect(rateLimit("ip:1", 2, 60_000, t).ok).toBe(true);
    expect(rateLimit("ip:1", 2, 60_000, t + 1).ok).toBe(true);
    expect(rateLimit("ip:1", 2, 60_000, t + 2)).toEqual({ ok: false, retryAfterSec: 60 });
  });

  it("resets after the window and keeps keys independent", () => {
    const t = 2_000_000;
    rateLimit("ip:2", 1, 1000, t);
    expect(rateLimit("ip:2", 1, 1000, t + 1).ok).toBe(false);
    expect(rateLimit("ip:3", 1, 1000, t + 1).ok).toBe(true);
    expect(rateLimit("ip:2", 1, 1000, t + 1000).ok).toBe(true);
  });
});

describe("peek / hit / refund", () => {
  beforeEach(resetRateLimits);

  it("peek never counts", () => {
    const t = 3_000_000;
    for (let i = 0; i < 100; i++) expect(peek("k", 1, t).ok).toBe(true);
    expect(hit("k", 60_000, t)).toBe(1);
    expect(peek("k", 2, t).ok).toBe(true);
  });

  it("blocks once `limit` hits are recorded, with a retry hint, until the window ends", () => {
    const t = 4_000_000;
    hit("k", 60_000, t);
    hit("k", 60_000, t + 1);
    expect(peek("k", 2, t + 2)).toEqual({ ok: false, retryAfterSec: 60 });
    expect(peek("k", 3, t + 2).ok).toBe(true);
    expect(peek("k", 2, t + 60_000).ok).toBe(true);
    expect(hit("k", 60_000, t + 60_000)).toBe(1);
  });

  it("refund takes back one hit and never goes below zero", () => {
    const t = 5_000_000;
    hit("k", 60_000, t);
    hit("k", 60_000, t);
    refund("k", t);
    expect(peek("k", 2, t).ok).toBe(true);
    refund("k", t);
    refund("k", t);
    expect(hit("k", 60_000, t)).toBe(1);
    refund("missing", t);
    expect(peek("missing", 1, t).ok).toBe(true);
  });

  it("shares buckets with rateLimit", () => {
    const t = 6_000_000;
    rateLimit("k", 5, 60_000, t);
    expect(hit("k", 60_000, t)).toBe(2);
  });
});
