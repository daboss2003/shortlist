import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { companyNameSchema, websiteSchema } from "@/lib/auth/accounts";
import { RETENTION_DAY_OPTIONS, type RetentionDays } from "@/lib/retention";

// Company-level settings. Every function is scoped by the caller's companyId (from the session).

export type CompanySettings = { name: string; website: string | null; retentionDays: number | null };

export async function getCompanySettings(companyId: string): Promise<CompanySettings | null> {
  const [settings] = await db
    .select({ name: companies.name, website: companies.website, retentionDays: companies.retentionDays })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return settings ?? null;
}

export const companyProfileSchema = z.object({ name: companyNameSchema, website: websiteSchema });
export type CompanyProfile = z.output<typeof companyProfileSchema>;
export type CompanyProfileField = keyof CompanyProfile;
export type CompanyProfileFieldErrors = Partial<Record<CompanyProfileField, string>>;

/** Validates and saves the company name and website (same rules as signup). */
export async function updateCompanyProfile(
  companyId: string,
  input: unknown,
): Promise<{ ok: true; profile: CompanyProfile } | { ok: false; fieldErrors: CompanyProfileFieldErrors }> {
  const parsed = companyProfileSchema.safeParse(input);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    return {
      ok: false,
      fieldErrors: Object.fromEntries(
        Object.entries(fieldErrors).map(([field, messages]) => [field, messages?.[0]]),
      ) as CompanyProfileFieldErrors,
    };
  }
  const updated = await db
    .update(companies)
    .set(parsed.data)
    .where(eq(companies.id, companyId))
    .returning({ id: companies.id });
  if (updated.length === 0) throw new Error("Company not found");
  return { ok: true, profile: parsed.data };
}

export const isRetentionDays = (days: unknown): days is RetentionDays | null =>
  days === null || (RETENTION_DAY_OPTIONS as readonly unknown[]).includes(days);

/** Sets how long candidate data is kept after a job closes; null turns retention off. Only the offered choices. */
export async function setRetentionDays(companyId: string, days: number | null): Promise<void> {
  if (!isRetentionDays(days)) throw new Error(`Unsupported retention period: ${String(days)}`);
  const updated = await db
    .update(companies)
    .set({ retentionDays: days })
    .where(eq(companies.id, companyId))
    .returning({ id: companies.id });
  if (updated.length === 0) throw new Error("Company not found");
}
