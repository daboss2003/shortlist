import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCompany } from "../../../test/factories";
import { getAiQuota, tryReserveAnalysis } from "./quota";

const at = (iso: string) => new Date(iso);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tryReserveAnalysis", () => {
  it("allows analyses up to AI_DAILY_LIMIT, then refuses without counting", () => {
    vi.stubEnv("AI_DAILY_LIMIT", "2");
    const { company } = makeCompany();
    const now = at("2026-10-07T09:00:00Z");

    expect(tryReserveAnalysis(company.id, now)).toBe(true);
    expect(tryReserveAnalysis(company.id, now)).toBe(true);
    expect(tryReserveAnalysis(company.id, now)).toBe(false);
    expect(tryReserveAnalysis(company.id, now)).toBe(false);

    expect(getAiQuota(company.id, now)).toEqual({
      used: 2,
      limit: 2,
      remaining: 0,
      resetsAt: at("2026-10-08T00:00:00Z"),
    });
  });

  it("starts a fresh allowance at midnight UTC", () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const { company } = makeCompany();

    expect(tryReserveAnalysis(company.id, at("2026-10-07T23:59:59.999Z"))).toBe(true);
    expect(tryReserveAnalysis(company.id, at("2026-10-07T23:59:59.999Z"))).toBe(false);
    expect(tryReserveAnalysis(company.id, at("2026-10-08T00:00:00Z"))).toBe(true);

    expect(getAiQuota(company.id, at("2026-10-08T12:00:00Z"))).toMatchObject({ used: 1, remaining: 0 });
    expect(getAiQuota(company.id, at("2026-10-07T12:00:00Z"))).toMatchObject({ used: 1, remaining: 0 });
  });

  it("counts each company separately", () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const a = makeCompany().company;
    const b = makeCompany().company;
    const now = at("2026-10-07T09:00:00Z");

    expect(tryReserveAnalysis(a.id, now)).toBe(true);
    expect(tryReserveAnalysis(a.id, now)).toBe(false);
    expect(tryReserveAnalysis(b.id, now)).toBe(true);
    expect(getAiQuota(b.id, now).used).toBe(1);
  });

  it.each(["0", "-5"])("is unlimited when AI_DAILY_LIMIT is %s, but still counts usage", (value) => {
    vi.stubEnv("AI_DAILY_LIMIT", value);
    const { company } = makeCompany();
    const now = at("2026-10-07T09:00:00Z");

    for (let i = 0; i < 600; i++) expect(tryReserveAnalysis(company.id, now)).toBe(true);
    expect(getAiQuota(company.id, now)).toMatchObject({ used: 600, limit: null, remaining: null });
  });
});

describe("getAiQuota", () => {
  it.each([
    [undefined, 500],
    ["", 500],
    ["abc", 500],
    ["12.5", 500],
    [" 40 ", 40],
  ])("reads AI_DAILY_LIMIT=%j as %s", (value, limit) => {
    if (value !== undefined) vi.stubEnv("AI_DAILY_LIMIT", value);
    else delete process.env.AI_DAILY_LIMIT;
    const { company } = makeCompany();
    expect(getAiQuota(company.id, at("2026-10-07T09:00:00Z"))).toEqual({
      used: 0,
      limit,
      remaining: limit,
      resetsAt: at("2026-10-08T00:00:00Z"),
    });
  });
});
