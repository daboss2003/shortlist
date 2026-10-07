"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { accountExists } from "@/lib/auth/accounts";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { createInvite, revokeInvite } from "@/lib/auth/invites";
import { INVITE_DAY_CHOICES } from "./invite-options";

// Platform-admin only: every action re-checks requirePlatformAdmin() (non-admins get a 404).

export type CreateInviteField = "email" | "days";

export type CreateInviteState = {
  fieldErrors?: Partial<Record<CreateInviteField, string>>;
  /** Echoed back after a failed submit so the form keeps what was typed. */
  values?: Partial<Record<CreateInviteField, string>>;
  /** The new invite. The raw link exists only in this response — the database keeps a hash. */
  created?: { url: string; email: string | null; expiresAt: string };
};

const createInviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200, "Keep the email under 200 characters.")
    .pipe(z.union([z.literal(""), z.email("Enter a valid email address, or leave it blank.")])),
  days: z.enum(INVITE_DAY_CHOICES, { error: "Choose when the invite expires." }).transform(Number),
});

const text = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

export async function createInviteAction(_prev: CreateInviteState, formData: FormData): Promise<CreateInviteState> {
  const admin = await requirePlatformAdmin();
  const values = { email: text(formData, "email"), days: text(formData, "days") };
  const parsed = createInviteSchema.safeParse(values);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    return { fieldErrors: { email: fieldErrors.email?.[0], days: fieldErrors.days?.[0] }, values };
  }
  const { email, days } = parsed.data;
  if (email && (await accountExists(email))) {
    return { fieldErrors: { email: "An account with this email already exists." }, values };
  }

  const invite = await createInvite({ email: email || null, days, createdByUserId: admin.userId });
  revalidatePath("/dashboard/admin/invites");
  return { created: { url: invite.url, email: invite.email, expiresAt: invite.expiresAt.toISOString() } };
}

export async function revokeInviteAction(inviteId: string): Promise<void> {
  await requirePlatformAdmin();
  const id = z.uuid().safeParse(inviteId);
  // Already used, revoked or gone (e.g. from another tab): nothing to do; the refreshed table shows its status.
  if (id.success) await revokeInvite(id.data);
  revalidatePath("/dashboard/admin/invites");
}
