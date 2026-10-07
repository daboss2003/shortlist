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

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
