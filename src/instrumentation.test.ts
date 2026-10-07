import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

const calls = vi.hoisted(() => [] as string[]);
const schema = vi.hoisted(() => ({ problem: null as string | null }));

vi.mock("@/db", () => ({
  ensureDbReady: async () => void calls.push("ensureDbReady"),
  findSchemaProblem: async () => schema.problem,
}));
vi.mock("@/lib/auth/seed-admin", () => ({ seedPlatformAdmin: async () => void calls.push("seedPlatformAdmin") }));
vi.mock("@/lib/pipeline", () => ({
  recoverInterruptedCandidates: async () => void calls.push("recoverInterruptedCandidates"),
  startPendingRequeue: () => void calls.push("startPendingRequeue"),
}));
vi.mock("@/lib/retention", () => ({ startRetentionSweeper: () => void calls.push("startRetentionSweeper") }));

beforeEach(() => {
  calls.length = 0;
  schema.problem = null;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("register", () => {
  it("prepares the database, seeds the admin, then starts recovery and the timers on a long-lived server", async () => {
    await register();
    expect(calls).toEqual([
      "ensureDbReady",
      "seedPlatformAdmin",
      "recoverInterruptedCandidates",
      "startPendingRequeue",
      "startRetentionSweeper",
    ]);
  });

  it.each([
    ["on Netlify", "NETLIFY", "true"],
    ["when Inngest is configured", "INNGEST_EVENT_KEY", "evt-key"],
    ["with the Inngest Dev Server", "INNGEST_DEV", "1"],
  ])("leaves recovery and the timers to the Inngest crons %s", async (_label, name, value) => {
    vi.stubEnv(name, value);
    await register();
    expect(calls).toEqual(["ensureDbReady", "seedPlatformAdmin"]);
  });

  it("explains a missing schema and skips seeding and recovery, instead of failing later", async () => {
    schema.problem = "The database at DATABASE_URL has no tables yet. Run `pnpm db:migrate`.";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await register();
    expect(calls).toEqual(["ensureDbReady"]);
    expect(error).toHaveBeenCalledWith(`[db] ${schema.problem}`);
    error.mockRestore();
  });

  it("does nothing in the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(calls).toEqual([]);
  });
});
