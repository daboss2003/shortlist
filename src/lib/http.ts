import { NextResponse } from "next/server";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/**
 * CSRF defence for cookie-authenticated mutating Route Handlers (Server Actions already check this).
 * Browsers always send Origin on cross-origin POSTs, so a present-but-foreign Origin is rejected.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Reverse proxies in front of the app that append to X-Forwarded-For. TRUST_PROXY_HOPS, default 1. */
function trustedProxyHops(): number {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  return Number.isInteger(hops) && hops >= 1 ? hops : 1;
}

// An IPv6 address with a zone id is under 64 characters; anything longer is junk and would bloat limiter keys.
const MAX_IP_LENGTH = 64;

/**
 * The client IP as seen by the nearest trusted proxy, for per-IP rate limits.
 * Each proxy appends the address it received the request from, so only the entries the trusted proxies
 * added (counted from the right) are reliable; anything to their left was sent by the client and is spoofable.
 */
export function clientIpFromHeaders(headers: Pick<Headers, "get">): string {
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ip = entries.length
    ? // Fewer entries than trusted hops means a proxy didn't append; the left-most is then the best we have.
      entries[Math.max(entries.length - trustedProxyHops(), 0)]
    : headers.get("x-real-ip")?.trim();
  return ip ? ip.slice(0, MAX_IP_LENGTH) : "unknown";
}

export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}
