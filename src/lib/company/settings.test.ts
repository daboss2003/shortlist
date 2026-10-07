import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { getCompanyRetentionDays } from "@/lib/retention";
import { makeCompany } from "../../../test/factories";
import { getCompanySettings, isRetentionDays, setRetentionDays, updateCompanyProfile } from "./settings";

const companyRow = (id: string) => db.select().from(companies).where(eq(companies.id, id)).get()!;

describe("getCompanySettings", () => {
  it("returns the name, website and retention (90 days by default)", () => {
    const { company } = makeCompany("Globex");
    expect(getCompanySettings(company.id)).toEqual({ name: "Globex", website: null, retentionDays: 90 });
  });

  it("returns null for a missing company", () => {
    expect(getCompanySettings(crypto.randomUUID())).toBeNull();
  });
});

describe("updateCompanyProfile", () => {
  it("trims the name and normalizes the website like signup does", () => {
    const { company } = makeCompany();
    expect(updateCompanyProfile(company.id, { name: "  Initech  ", website: "Initech.com/careers" })).toEqual({
      ok: true,
      profile: { name: "Initech", website: "https://initech.com/careers" },
    });
    expect(companyRow(company.id)).toMatchObject({ name: "Initech", website: "https://initech.com/careers" });
  });

  it("clears the website when it's left blank", () => {
    const { company } = makeCompany();
    updateCompanyProfile(company.id, { name: "Initech", website: "initech.com" });
    expect(updateCompanyProfile(company.id, { name: "Initech", website: "  " })).toMatchObject({ ok: true });
    expect(companyRow(company.id).website).toBeNull();
  });

  it("returns field errors and writes nothing for invalid input", () => {
    const { company } = makeCompany("Before");
    const result = updateCompanyProfile(company.id, { name: "A", website: "javascript:alert(1)" });
    expect(result).toEqual({
      ok: false,
      fieldErrors: { name: "Company name must be at least 2 characters.", website: "Enter a valid website, like acme.com." },
    });
    expect(updateCompanyProfile(company.id, { name: "x".repeat(121) })).toMatchObject({ ok: false });
    expect(companyRow(company.id)).toMatchObject({ name: "Before", website: null });
  });

  it("only changes the given company", () => {
    const a = makeCompany("A Corp");
    const b = makeCompany("B Corp");
    updateCompanyProfile(a.company.id, { name: "A Renamed" });
    expect(companyRow(b.company.id).name).toBe("B Corp");
    expect(() => updateCompanyProfile(crypto.randomUUID(), { name: "Ghost" })).toThrow();
  });
});

describe("setRetentionDays", () => {
  it("accepts the offered periods and Off (null)", () => {
    const { company } = makeCompany();
    for (const days of [30, 180, null, 90] as const) {
      setRetentionDays(company.id, days);
      expect(getCompanyRetentionDays(company.id)).toBe(days);
    }
  });

  it("rejects anything else without writing", () => {
    const { company } = makeCompany();
    for (const days of [0, 1, 7, 89, 365, -30, 90.5, Number.NaN]) {
      expect(() => setRetentionDays(company.id, days)).toThrow();
    }
    expect(() => setRetentionDays(company.id, "90" as never)).toThrow();
    expect(companyRow(company.id).retentionDays).toBe(90);
  });

  it("only changes the given company", () => {
    const a = makeCompany();
    const b = makeCompany();
    setRetentionDays(a.company.id, 30);
    expect(getCompanyRetentionDays(b.company.id)).toBe(90);
    expect(() => setRetentionDays(crypto.randomUUID(), 30)).toThrow();
  });
});

describe("isRetentionDays", () => {
  it("is the allowlist", () => {
    expect([30, 90, 180, null].every(isRetentionDays)).toBe(true);
    expect([0, 60, "30", undefined].some(isRetentionDays)).toBe(false);
  });
});
