import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCompany } from "../../../test/factories";
import { getAiQuota, tryReserveAnalysis } from "./quota";

const at = (iso: string) => new Date(iso);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tryReserveAnalysis", () => {
  it("allows analyses up to AI_DAILY_LIMIT, then refuses without counting", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "2");
    const { company } = await makeCompany();
    const now = at("2026-10-07T09:00:00Z");

    expect(await tryReserveAnalysis(company.id, now)).toBe(true);
    expect(await tryReserveAnalysis(company.id, now)).toBe(true);
    expect(await tryReserveAnalysis(company.id, now)).toBe(false);
    expect(await tryReserveAnalysis(company.id, now)).toBe(false);

    expect(await getAiQuota(company.id, now)).toEqual({
      used: 2,
      limit: 2,
      remaining: 0,
      resetsAt: at("2026-10-08T00:00:00Z"),
    });
  });

  it("hands out exactly the remaining slots to concurrent reservations", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "3");
    const { company } = await makeCompany();
    const now = at("2026-10-07T09:00:00Z");

    const results = await Promise.all(Array.from({ length: 10 }, () => tryReserveAnalysis(company.id, now)));

    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await getAiQuota(company.id, now)).toMatchObject({ used: 3, remaining: 0 });
  });

  it("starts a fresh allowance at midnight UTC", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const { company } = await makeCompany();

    expect(await tryReserveAnalysis(company.id, at("2026-10-07T23:59:59.999Z"))).toBe(true);
    expect(await tryReserveAnalysis(company.id, at("2026-10-07T23:59:59.999Z"))).toBe(false);
    expect(await tryReserveAnalysis(company.id, at("2026-10-08T00:00:00Z"))).toBe(true);

    expect(await getAiQuota(company.id, at("2026-10-08T12:00:00Z"))).toMatchObject({ used: 1, remaining: 0 });
    expect(await getAiQuota(company.id, at("2026-10-07T12:00:00Z"))).toMatchObject({ used: 1, remaining: 0 });
  });

  it("counts each company separately", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const a = (await makeCompany()).company;
    const b = (await makeCompany()).company;
    const now = at("2026-10-07T09:00:00Z");

    expect(await tryReserveAnalysis(a.id, now)).toBe(true);
    expect(await tryReserveAnalysis(a.id, now)).toBe(false);
    expect(await tryReserveAnalysis(b.id, now)).toBe(true);
    expect((await getAiQuota(b.id, now)).used).toBe(1);
  });

  it.each(["0", "-5"])("is unlimited when AI_DAILY_LIMIT is %s, but still counts usage", async (value) => {
    vi.stubEnv("AI_DAILY_LIMIT", value);
    const { company } = await makeCompany();
    const now = at("2026-10-07T09:00:00Z");

    for (let i = 0; i < 600; i++) expect(await tryReserveAnalysis(company.id, now)).toBe(true);
    expect(await getAiQuota(company.id, now)).toMatchObject({ used: 600, limit: null, remaining: null });
  });
});

describe("getAiQuota", () => {
  it.each([
    [undefined, 500],
    ["", 500],
    ["abc", 500],
    ["12.5", 500],
    [" 40 ", 40],
  ])("reads AI_DAILY_LIMIT=%j as %s", async (value, limit) => {
    if (value !== undefined) vi.stubEnv("AI_DAILY_LIMIT", value);
    else delete process.env.AI_DAILY_LIMIT;
    const { company } = await makeCompany();
    expect(await getAiQuota(company.id, at("2026-10-07T09:00:00Z"))).toEqual({
      used: 0,
      limit,
      remaining: limit,
      resetsAt: at("2026-10-08T00:00:00Z"),
    });
  });
});
