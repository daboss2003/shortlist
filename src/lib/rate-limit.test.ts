import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "./rate-limit";

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
