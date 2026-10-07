import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST, PUT } from "./route";

// `connection()` needs a Next request scope, which tests don't have; everything else in next/server is real.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const URL = "https://cv.example.com/api/inngest?fnId=cv-review-pipeline-process-cv&stepId=step";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/api/inngest", () => {
  it("rejects a call that isn't signed with INNGEST_SIGNING_KEY", async () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-prod-${"ab".repeat(32)}`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({ event: { name: "cv/process.requested", data: { candidateId: "x", companyId: "y" } } });

    const res = await POST(new NextRequest(URL, { method: "POST", body, headers: { "content-type": "application/json" } }), {});

    expect(res.status).toBe(401);
  });

  it("refuses an unsigned sync (PUT) without registering anything with Inngest", async () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-prod-${"ab".repeat(32)}`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The SDK registers by POSTing to Inngest's API with fetch: a registration would show up here.
    const fetchSpy = vi.fn(async () => Response.json({ ok: true, modified: true }));
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const res = await PUT(new NextRequest("https://evil.example.com/api/inngest", { method: "PUT" }), {});

      expect(res.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks once for APP_URL on a deployed site without it", async () => {
    vi.stubEnv("NETLIFY", "true");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-prod-${"ab".repeat(32)}`);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await GET(new NextRequest(URL), {});
    await GET(new NextRequest(URL), {});

    expect(errorLog.mock.calls.filter(([msg]) => String(msg).includes("APP_URL"))).toHaveLength(1);
  });

  it.each([
    ["GET", GET],
    ["POST", POST],
    ["PUT", PUT],
  ] as const)("refuses %s on a deployed site while INNGEST_DEV turns signature checks off", async (method, handler) => {
    vi.stubEnv("NETLIFY", "true");
    vi.stubEnv("INNGEST_DEV", "1");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await handler(new NextRequest(URL, { method }), {});

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Background jobs are misconfigured." });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("INNGEST_DEV"));
  });
});
