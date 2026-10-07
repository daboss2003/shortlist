import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp, clientIpFromHeaders } from "./http";

const req = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

describe("clientIp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to one trusted hop: the right-most X-Forwarded-For entry, which the proxy appended", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    // The client sent "1.1.1.1" itself; the proxy appended the real address.
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores spoofed left-most entries no matter how many are sent", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "1");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9,8.8.8.8 , 7.7.7.7,  198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("counts TRUST_PROXY_HOPS entries from the right", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "2");
    // client spoof, real client (added by the outer proxy), outer proxy (added by the inner proxy)
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9, 10.0.0.2" }))).toBe("203.0.113.9");
  });

  it("uses the left-most entry when there are fewer entries than hops", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "3");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" }))).toBe("203.0.113.9");
  });

  it("falls back to the default of one hop for an invalid TRUST_PROXY_HOPS", () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      vi.stubEnv("TRUST_PROXY_HOPS", bad);
      expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }))).toBe("203.0.113.9");
    }
  });

  it("skips blank entries", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9, " }))).toBe("203.0.113.9");
  });

  it("uses X-Real-IP without X-Forwarded-For, else 'unknown'", () => {
    expect(clientIp(req({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-forwarded-for": " , ", "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("caps the length so junk can't become a huge rate-limit key", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "5");
    expect(clientIp(req({ "x-forwarded-for": "x".repeat(10_000) })).length).toBe(64);
  });

  it("works with any headers object (Server Actions read next/headers)", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }))).toBe("203.0.113.9");
  });
});

describe("security headers (next.config.ts)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function headersFor(nodeEnv: string) {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.resetModules();
    const { default: config } = await import("../../next.config");
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    return Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
  }

  it("denies framing and sets the baseline headers on every route", async () => {
    expect(await headersFor("development")).toEqual({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("adds HSTS in production only", async () => {
    expect(await headersFor("production")).toMatchObject({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Frame-Options": "DENY",
    });
  });
});
