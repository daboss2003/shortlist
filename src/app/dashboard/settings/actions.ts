"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireEmployer } from "@/lib/auth/dal";
import {
  isRetentionDays,
  setRetentionDays,
  updateCompanyProfile,
  type CompanyProfileFieldErrors,
} from "@/lib/company/settings";

export type CompanyProfileState = {
  ok?: true;
  fieldErrors?: CompanyProfileFieldErrors;
  /** Echoed back (normalized after a save) so the form shows it after React's post-action reset. */
  values?: { name: string; website: string };
};

export type RetentionState = { ok?: true; error?: string };

const text = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

export async function updateCompanyProfileAction(
  _prev: CompanyProfileState,
  formData: FormData,
): Promise<CompanyProfileState> {
  const { companyId } = await requireEmployer();
  const values = { name: text(formData, "name"), website: text(formData, "website") };
  const result = await updateCompanyProfile(companyId, values);
  if (!result.ok) return { fieldErrors: result.fieldErrors, values };

  // The company name is in the dashboard header; name and website are on every public job page.
  revalidatePath("/dashboard", "layout");
  revalidatePath("/apply/[slug]", "page");
  return { ok: true, values: { name: result.profile.name, website: result.profile.website ?? "" } };
}

/** The select posts "off" or a number of days; only the offered choices get through. */
const retentionSchema = z
  .string()
  .transform((value) => (value === "off" ? null : Number(value)))
  .refine(isRetentionDays);

export async function updateRetentionAction(_prev: RetentionState, formData: FormData): Promise<RetentionState> {
  const { companyId } = await requireEmployer();
  const parsed = retentionSchema.safeParse(formData.get("retentionDays"));
  if (!parsed.success) return { error: "Choose a retention period from the list." };

  await setRetentionDays(companyId, parsed.data);
  revalidatePath("/dashboard", "layout");
  return { ok: true };
}
