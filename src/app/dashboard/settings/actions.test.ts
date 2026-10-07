import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import type { Employer } from "@/lib/auth/dal";
import { makeCompany } from "../../../../test/factories";

const mocks = vi.hoisted(() => ({ employer: null as Employer | null, revalidatePath: vi.fn() }));

vi.mock("@/lib/auth/dal", () => ({
  requireEmployer: async () => {
    if (!mocks.employer) throw new Error("REDIRECT:/login");
    return mocks.employer;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const { updateCompanyProfileAction, updateRetentionAction } = await import("./actions");

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const companyRow = async (id: string) => (await db.select().from(companies).where(eq(companies.id, id)))[0];

async function signIn() {
  const { company, user } = await makeCompany("Before Co");
  mocks.employer = {
    userId: user.id,
    name: user.name,
    email: user.email,
    companyId: company.id,
    companyName: company.name,
    companyWebsite: null,
    isPlatformAdmin: false,
  };
  return company;
}

beforeEach(() => {
  mocks.employer = null;
  mocks.revalidatePath.mockClear();
});

describe("updateCompanyProfileAction", () => {
  it("requires a signed-in employer", async () => {
    await expect(updateCompanyProfileAction({}, form({ name: "X Co" }))).rejects.toThrow("REDIRECT:/login");
  });

  it("saves the signed-in company's profile and echoes the normalized values", async () => {
    const company = await signIn();
    const other = (await makeCompany("Other Co")).company;
    const state = await updateCompanyProfileAction({}, form({ name: " Initech ", website: "initech.com" }));
    expect(state).toEqual({ ok: true, values: { name: "Initech", website: "https://initech.com" } });
    expect(await companyRow(company.id)).toMatchObject({ name: "Initech", website: "https://initech.com" });
    expect((await companyRow(other.id)).name).toBe("Other Co");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/apply/[slug]", "page");
  });

  it("returns field errors and keeps what was typed", async () => {
    const company = await signIn();
    const state = await updateCompanyProfileAction({}, form({ name: "A", website: "ftp://x.com" }));
    expect(state).toMatchObject({
      fieldErrors: { name: expect.any(String), website: expect.any(String) },
      values: { name: "A", website: "ftp://x.com" },
    });
    expect((await companyRow(company.id)).name).toBe("Before Co");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updateRetentionAction", () => {
  it("requires a signed-in employer", async () => {
    await expect(updateRetentionAction({}, form({ retentionDays: "30" }))).rejects.toThrow("REDIRECT:/login");
  });

  it("saves an offered period, or Off", async () => {
    const company = await signIn();
    expect(await updateRetentionAction({}, form({ retentionDays: "180" }))).toEqual({ ok: true });
    expect((await companyRow(company.id)).retentionDays).toBe(180);
    expect(await updateRetentionAction({}, form({ retentionDays: "off" }))).toEqual({ ok: true });
    expect((await companyRow(company.id)).retentionDays).toBeNull();
  });

  it("rejects anything else without writing", async () => {
    const company = await signIn();
    for (const value of ["", "0", "1", "365", "90abc", "null", "-30"]) {
      expect(await updateRetentionAction({}, form({ retentionDays: value }))).toEqual({
        error: "Choose a retention period from the list.",
      });
    }
    expect(await updateRetentionAction({}, new FormData())).toMatchObject({ error: expect.any(String) });
    expect((await companyRow(company.id)).retentionDays).toBe(90);
  });
});
