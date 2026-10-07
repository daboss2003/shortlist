import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { companies, invites, users, type Invite } from "@/db/schema";

// Signups are invite-only. The raw token only ever lives in the link; the table stores sha256(token).
// scripts/invite.mjs (`pnpm invite`) mirrors createInvite in plain JS — keep the two in step.

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INVITE_DAYS = 14;

/** One message for every unusable invite (missing, unknown, expired, used, revoked, other email), so it reveals nothing. */
export const INVITE_ERROR = "This invite link is invalid or has expired. Ask for a new one.";

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** 32 random bytes in base64url is 43 characters; anything far off can't be one of ours. */
const isWellFormedToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(token);

export function inviteUrl(token: string): string {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/signup?invite=${token}`;
}

export type CreatedInvite = { id: string; token: string; url: string; email: string | null; expiresAt: Date };

export function createInvite({
  email,
  days = DEFAULT_INVITE_DAYS,
  createdByUserId,
}: { email?: string | null; days?: number; createdByUserId?: string | null } = {}): CreatedInvite {
  if (!Number.isFinite(days) || days <= 0) throw new Error("Invite validity must be a positive number of days");
  const token = randomBytes(32).toString("base64url");
  const invite = db
    .insert(invites)
    .values({
      tokenHash: hashInviteToken(token),
      email: email?.trim().toLowerCase() || null,
      expiresAt: new Date(Date.now() + days * DAY_MS),
      createdByUserId: createdByUserId ?? null,
    })
    .returning()
    .get();
  return { id: invite.id, token, url: inviteUrl(token), email: invite.email, expiresAt: invite.expiresAt };
}

/** Where-clause for an invite that can still be redeemed at `now` (by `email`, when given). */
function usableInviteWhere(token: string, now: Date, email?: string): SQL {
  return and(
    eq(invites.tokenHash, hashInviteToken(token)),
    isNull(invites.usedAt),
    isNull(invites.revokedAt),
    gt(invites.expiresAt, now),
    email === undefined ? undefined : or(isNull(invites.email), eq(invites.email, email)),
  )!;
}

/** The invite if it exists and is unused, unrevoked and unexpired; else null. Doesn't check the email. */
export function findUsableInvite(token: unknown, now: Date = new Date()): Invite | null {
  if (!isWellFormedToken(token)) return null;
  return db.select().from(invites).where(usableInviteWhere(token, now)).get() ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Marks the invite used by `userId`, atomically re-checking that it is still usable and (if bound to an
 * email) for `email`. Call inside the signup transaction; false means it must roll back.
 */
export function redeemInvite(tx: Tx, token: unknown, userId: string, email: string, now: Date = new Date()): boolean {
  if (!isWellFormedToken(token)) return false;
  const { changes } = tx
    .update(invites)
    .set({ usedAt: now, usedByUserId: userId })
    .where(usableInviteWhere(token, now, email))
    .run();
  return changes === 1;
}

export const INVITE_STATUSES = ["pending", "used", "expired", "revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export type InviteListItem = {
  id: string;
  email: string | null;
  status: InviteStatus;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  /** Company created with this invite; null if unused, or if that account has since been deleted. */
  usedByCompanyName: string | null;
};

export function inviteStatus(
  invite: Pick<Invite, "usedAt" | "revokedAt" | "expiresAt">,
  now: Date = new Date(),
): InviteStatus {
  if (invite.usedAt) return "used";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** Every invite, newest first. Platform-admin only — callers must check. */
export function listInvites(now: Date = new Date()): InviteListItem[] {
  return db
    .select({
      id: invites.id,
      email: invites.email,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      usedAt: invites.usedAt,
      revokedAt: invites.revokedAt,
      usedByCompanyName: companies.name,
    })
    .from(invites)
    .leftJoin(users, eq(users.id, invites.usedByUserId))
    .leftJoin(companies, eq(companies.id, users.companyId))
    .orderBy(desc(invites.createdAt), desc(invites.id))
    .all()
    .map((row) => ({ ...row, status: inviteStatus(row, now) }));
}

/** Revokes an unused, unrevoked invite. Returns false if there was nothing to revoke. */
export function revokeInvite(id: string, now: Date = new Date()): boolean {
  return (
    db
      .update(invites)
      .set({ revokedAt: now })
      .where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt)))
      .run().changes === 1
  );
}
