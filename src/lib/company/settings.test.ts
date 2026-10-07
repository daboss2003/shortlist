import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { getCompanyRetentionDays } from "@/lib/retention";
import { makeCompany } from "../../../test/factories";
import { getCompanySettings, isRetentionDays, setRetentionDays, updateCompanyProfile } from "./settings";

const companyRow = async (id: string) => (await db.select().from(companies).where(eq(companies.id, id)))[0];

describe("getCompanySettings", () => {
  it("returns the name, website and retention (90 days by default)", async () => {
    const { company } = await makeCompany("Globex");
    expect(await getCompanySettings(company.id)).toEqual({ name: "Globex", website: null, retentionDays: 90 });
  });

  it("returns null for a missing company", async () => {
    expect(await getCompanySettings(crypto.randomUUID())).toBeNull();
  });
});

describe("updateCompanyProfile", () => {
  it("trims the name and normalizes the website like signup does", async () => {
    const { company } = await makeCompany();
    expect(await updateCompanyProfile(company.id, { name: "  Initech  ", website: "Initech.com/careers" })).toEqual({
      ok: true,
      profile: { name: "Initech", website: "https://initech.com/careers" },
    });
    expect(await companyRow(company.id)).toMatchObject({ name: "Initech", website: "https://initech.com/careers" });
  });

  it("clears the website when it's left blank", async () => {
    const { company } = await makeCompany();
    await updateCompanyProfile(company.id, { name: "Initech", website: "initech.com" });
    expect(await updateCompanyProfile(company.id, { name: "Initech", website: "  " })).toMatchObject({ ok: true });
    expect((await companyRow(company.id)).website).toBeNull();
  });

  it("returns field errors and writes nothing for invalid input", async () => {
    const { company } = await makeCompany("Before");
    const result = await updateCompanyProfile(company.id, { name: "A", website: "javascript:alert(1)" });
    expect(result).toEqual({
      ok: false,
      fieldErrors: { name: "Company name must be at least 2 characters.", website: "Enter a valid website, like acme.com." },
    });
    expect(await updateCompanyProfile(company.id, { name: "x".repeat(121) })).toMatchObject({ ok: false });
    expect(await companyRow(company.id)).toMatchObject({ name: "Before", website: null });
  });

  it("returns a field error for a NUL character instead of a failed update", async () => {
    const { company } = await makeCompany("Before");
    expect(await updateCompanyProfile(company.id, { name: "Init\u0000ech", website: "initech.com/\u0000" })).toEqual({
      ok: false,
      fieldErrors: { name: "Contains an invalid character.", website: "Contains an invalid character." },
    });
    expect(await companyRow(company.id)).toMatchObject({ name: "Before", website: null });
  });

  it("only changes the given company", async () => {
    const a = await makeCompany("A Corp");
    const b = await makeCompany("B Corp");
    await updateCompanyProfile(a.company.id, { name: "A Renamed" });
    expect((await companyRow(b.company.id)).name).toBe("B Corp");
    await expect(updateCompanyProfile(crypto.randomUUID(), { name: "Ghost" })).rejects.toThrow("Company not found");
  });
});

describe("setRetentionDays", () => {
  it("accepts the offered periods and Off (null)", async () => {
    const { company } = await makeCompany();
    for (const days of [30, 180, null, 90] as const) {
      await setRetentionDays(company.id, days);
      expect(await getCompanyRetentionDays(company.id)).toBe(days);
    }
  });

  it("rejects anything else without writing", async () => {
    const { company } = await makeCompany();
    for (const days of [0, 1, 7, 89, 365, -30, 90.5, Number.NaN]) {
      await expect(setRetentionDays(company.id, days)).rejects.toThrow("Unsupported retention period");
    }
    await expect(setRetentionDays(company.id, "90" as never)).rejects.toThrow("Unsupported retention period");
    expect((await companyRow(company.id)).retentionDays).toBe(90);
  });

  it("only changes the given company", async () => {
    const a = await makeCompany();
    const b = await makeCompany();
    await setRetentionDays(a.company.id, 30);
    expect(await getCompanyRetentionDays(b.company.id)).toBe(90);
    await expect(setRetentionDays(crypto.randomUUID(), 30)).rejects.toThrow("Company not found");
  });
});

describe("isRetentionDays", () => {
  it("is the allowlist", () => {
    expect([30, 90, 180, null].every(isRetentionDays)).toBe(true);
    expect([0, 60, "30", undefined].some(isRetentionDays)).toBe(false);
  });
});
