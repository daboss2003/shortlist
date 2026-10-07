import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { companies, users } from "@/db/schema";
import { hasNul, safeText } from "@/lib/validation";
import { INVITE_ERROR, findUsableInvite, redeemInvite } from "./invites";
import { hashPassword, verifyPassword } from "./password";

const WEBSITE_ERROR = "Enter a valid website, like acme.com.";

/** "acme.com" → "https://acme.com". Only http(s) on a dotted host, no credentials. Empty → null. */
export const websiteSchema = safeText()
  .trim()
  .optional()
  .transform((value, ctx) => {
    if (!value) return null;
    const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      ctx.addIssue({ code: "custom", message: WEBSITE_ERROR });
      return z.NEVER;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !/^[a-z\d-]+(\.[a-z\d-]+)+$/i.test(url.hostname)
    ) {
      ctx.addIssue({ code: "custom", message: WEBSITE_ERROR });
      return z.NEVER;
    }
    const normalized =
      url.pathname === "/" && !url.search && !url.hash ? `${url.protocol}//${url.host}` : url.href;
    if (normalized.length > 200) {
      ctx.addIssue({ code: "custom", message: "Keep the website under 200 characters." });
      return z.NEVER;
    }
    return normalized;
  });

export const companyNameSchema = safeText()
  .trim()
  .min(1, "Enter your company name.")
  .min(2, "Company name must be at least 2 characters.")
  .max(120, "Keep the company name under 120 characters.");

export const signupSchema = z.object({
  companyName: companyNameSchema,
  website: websiteSchema,
  name: safeText().trim().min(1, "Enter your name.").max(120, "Keep your name under 120 characters."),
  email: safeText()
    .trim()
    .toLowerCase()
    .min(1, "Enter your work email.")
    .max(200, "Keep the email under 200 characters.")
    .pipe(z.email("Enter a valid email address.")),
  // Intentional: z.string(), not safeText() — the password is only ever hashed, never stored or queried as text.
  password: z.string().min(8, "Use at least 8 characters.").max(200, "Use 200 characters or fewer."),
});

export type SignupInput = z.output<typeof signupSchema>;
export type SignupField = keyof SignupInput;
export type SignupFieldErrors = Partial<Record<SignupField, string>>;

export type RegisterResult =
  | { ok: true; userId: string }
  | { ok: false; fieldErrors: SignupFieldErrors; formError?: string };

const inviteFailure = (): RegisterResult => ({ ok: false, fieldErrors: {}, formError: INVITE_ERROR });

class InviteNotRedeemedError extends Error {}

/**
 * Validates the signup form and creates a company with its first user, redeeming the invite in the same
 * transaction. Any unusable invite (missing, expired, used, revoked, for another email) gets one generic error.
 */
export async function registerCompany(input: unknown, inviteToken: unknown): Promise<RegisterResult> {
  // Cheap early exit so invite-less submissions never cost a password hash. Redemption below re-checks atomically.
  const invite = await findUsableInvite(inviteToken);
  if (!invite) return inviteFailure();

  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    return {
      ok: false,
      fieldErrors: Object.fromEntries(
        Object.entries(fieldErrors).map(([field, messages]) => [field, messages?.[0]]),
      ) as SignupFieldErrors,
    };
  }

  const data = parsed.data;
  if (invite.email && invite.email !== data.email) return inviteFailure();

  // Hash before the transaction so the slow scrypt never runs while it holds locks or a pooled connection.
  const passwordHash = await hashPassword(data.password);
  try {
    const userId = await db.transaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({ name: data.companyName, website: data.website })
        .returning({ id: companies.id });
      const [user] = await tx
        .insert(users)
        .values({ companyId: company.id, name: data.name, email: data.email, passwordHash })
        .returning({ id: users.id });
      // Used, revoked or expired since the check above (e.g. a parallel signup with the same link): throwing
      // rolls back the company and user.
      if (!(await redeemInvite(tx, inviteToken, user.id, data.email))) throw new InviteNotRedeemedError();
      return user.id;
    });
    return { ok: true, userId };
  } catch (err) {
    if (err instanceof InviteNotRedeemedError) return inviteFailure();
    if (isUniqueViolation(err)) {
      return { ok: false, fieldErrors: { email: "An account with this email already exists." } };
    }
    throw err;
  }
}

/** Whether an account already uses this email (any casing). */
export async function accountExists(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  // No stored email can contain NUL (signup rejects it), and Postgres would refuse the query.
  if (!normalized || hasNul(normalized)) return false;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized)).limit(1);
  return !!user;
}

// A real scrypt hash (same N/r/p and key length as hashPassword) of a random password nobody knows.
const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$qBCtVcd5hgklDBwgeVt0Gg==$ObvcXyfqsWF0NsErDChuEmmAk9Q/9atssqX9zT7ZniXFJTcvgriXilyXNdKyX+UqCPirtW6wH84OTmd3RFov4Q==";

/** Returns the user id when the email + password match, else null. */
export async function authenticate(email: string, password: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  // An email with NUL can't match an account (signup rejects it), and Postgres would refuse the query.
  const [user] = normalized && !hasNul(normalized)
    ? await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, normalized))
        .limit(1)
    : [];
  if (!user) {
    // Intentional: verify against a dummy hash for unknown emails so the response takes as long as a
    // wrong password would — otherwise response timing reveals which emails have accounts.
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user.id : null;
}

/** Postgres unique_violation (23505). Drizzle wraps the driver error, so walk the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
