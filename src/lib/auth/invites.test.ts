import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invites, users } from "@/db/schema";
import { makeCompany } from "../../../test/factories";
import {
  createInvite,
  findUsableInvite,
  hashInviteToken,
  inviteStatus,
  listInvites,
  redeemInvite,
  revokeInvite,
} from "./invites";

const DAY = 24 * 60 * 60 * 1000;
const row = (id: string) => db.select().from(invites).where(eq(invites.id, id)).get()!;
const redeem = (token: string, userId: string, email: string, now?: Date) =>
  db.transaction((tx) => redeemInvite(tx, token, userId, email, now));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createInvite", () => {
  it("returns a 32-byte base64url token and stores only its sha256", () => {
    const invite = createInvite();
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(invite.token, "base64url")).toHaveLength(32);

    const stored = row(invite.id);
    expect(stored.tokenHash).toBe(createHash("sha256").update(invite.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(invite.token);
    expect(stored).toMatchObject({ email: null, usedAt: null, revokedAt: null, createdByUserId: null });
  });

  it("builds the signup URL from APP_URL, defaulting to localhost", () => {
    vi.stubEnv("APP_URL", "");
    const local = createInvite();
    expect(local.url).toBe(`http://localhost:3000/signup?invite=${local.token}`);

    vi.stubEnv("APP_URL", "https://hire.example.com/");
    const prod = createInvite();
    expect(prod.url).toBe(`https://hire.example.com/signup?invite=${prod.token}`);
  });

  it("expires after 14 days by default, or the given number of days", () => {
    const before = Date.now();
    expect(createInvite().expiresAt.getTime()).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect(createInvite().expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    expect(createInvite({ days: 7 }).expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    expect(() => createInvite({ days: 0 })).toThrow();
    expect(() => createInvite({ days: Number.NaN })).toThrow();
  });

  it("lowercases the email, and records who created it", () => {
    const { user } = makeCompany();
    const invite = createInvite({ email: "  Jane@Acme.COM ", createdByUserId: user.id });
    expect(row(invite.id)).toMatchObject({ email: "jane@acme.com", createdByUserId: user.id });
    expect(invite.email).toBe("jane@acme.com");
  });

  it("makes a new token every time", () => {
    expect(createInvite().token).not.toBe(createInvite().token);
  });
});

describe("findUsableInvite", () => {
  it("finds an unused, unexpired invite by its raw token", () => {
    const invite = createInvite({ email: "a@b.co" });
    expect(findUsableInvite(invite.token)).toMatchObject({ id: invite.id, email: "a@b.co" });
  });

  it("returns null for unknown, malformed, expired, used and revoked invites", () => {
    expect(findUsableInvite(undefined)).toBeNull();
    expect(findUsableInvite("")).toBeNull();
    expect(findUsableInvite("x".repeat(10_000))).toBeNull();
    expect(findUsableInvite("A".repeat(43))).toBeNull();

    const expired = createInvite({ days: 1 });
    expect(findUsableInvite(expired.token, new Date(Date.now() + 2 * DAY))).toBeNull();

    const { user } = makeCompany();
    const used = createInvite();
    expect(redeem(used.token, user.id, user.email)).toBe(true);
    expect(findUsableInvite(used.token)).toBeNull();

    const revoked = createInvite();
    revokeInvite(revoked.id);
    expect(findUsableInvite(revoked.token)).toBeNull();
  });

  it("doesn't match on the hash itself", () => {
    const invite = createInvite();
    expect(findUsableInvite(hashInviteToken(invite.token))).toBeNull();
  });
});

describe("redeemInvite", () => {
  it("works once", () => {
    const { user } = makeCompany();
    const invite = createInvite();
    expect(redeem(invite.token, user.id, user.email)).toBe(true);
    expect(row(invite.id)).toMatchObject({ usedByUserId: user.id });
    expect(redeem(invite.token, user.id, user.email)).toBe(false);
  });

  it("refuses an expired, revoked or other-email invite", () => {
    const { user } = makeCompany();
    const expired = createInvite({ days: 1 });
    expect(redeem(expired.token, user.id, user.email, new Date(Date.now() + 2 * DAY))).toBe(false);

    const revoked = createInvite();
    revokeInvite(revoked.id);
    expect(redeem(revoked.token, user.id, user.email)).toBe(false);

    const bound = createInvite({ email: "invited@acme.com" });
    expect(redeem(bound.token, user.id, "other@acme.com")).toBe(false);
    expect(redeem(bound.token, user.id, "invited@acme.com")).toBe(true);

    expect(row(expired.id).usedAt).toBeNull();
    expect(row(revoked.id).usedAt).toBeNull();
  });
});

describe("revokeInvite", () => {
  it("revokes a pending invite once", () => {
    const invite = createInvite();
    expect(revokeInvite(invite.id)).toBe(true);
    expect(row(invite.id).revokedAt).toBeInstanceOf(Date);
    expect(revokeInvite(invite.id)).toBe(false);
  });

  it("can't revoke a used invite or a missing one", () => {
    const { user } = makeCompany();
    const invite = createInvite();
    redeem(invite.token, user.id, user.email);
    expect(revokeInvite(invite.id)).toBe(false);
    expect(row(invite.id).revokedAt).toBeNull();
    expect(revokeInvite(crypto.randomUUID())).toBe(false);
  });
});

describe("listInvites", () => {
  it("lists every invite newest first with its status and the redeeming company", () => {
    const now = new Date();
    const { company, user } = makeCompany("Globex Hiring");

    const pending = createInvite({ email: "p@acme.com" });
    const used = createInvite();
    redeem(used.token, user.id, user.email);
    const revoked = createInvite();
    revokeInvite(revoked.id);
    const expired = createInvite({ days: 1 });
    db.update(invites).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(invites.id, expired.id)).run();

    const list = listInvites(now);
    const byId = Object.fromEntries(list.map((i) => [i.id, i]));
    expect(byId[pending.id]).toMatchObject({ status: "pending", email: "p@acme.com", usedByCompanyName: null });
    expect(byId[used.id]).toMatchObject({ status: "used", usedByCompanyName: company.name });
    expect(byId[revoked.id]).toMatchObject({ status: "revoked" });
    expect(byId[expired.id]).toMatchObject({ status: "expired" });
    expect(list.map((i) => i.createdAt.getTime())).toEqual(
      [...list.map((i) => i.createdAt.getTime())].sort((a, b) => b - a),
    );
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|token_hash/);
  });

  it("still shows a used invite as used after the account is deleted", () => {
    const { user } = makeCompany();
    const invite = createInvite();
    redeem(invite.token, user.id, user.email);
    db.delete(users).where(eq(users.id, user.id)).run();
    expect(listInvites().find((i) => i.id === invite.id)).toMatchObject({ status: "used", usedByCompanyName: null });
  });
});

describe("inviteStatus", () => {
  const now = new Date("2027-01-01T00:00:00Z");
  const later = new Date(now.getTime() + DAY);
  const earlier = new Date(now.getTime() - DAY);

  it("used beats revoked beats expired", () => {
    expect(inviteStatus({ usedAt: earlier, revokedAt: null, expiresAt: earlier }, now)).toBe("used");
    expect(inviteStatus({ usedAt: null, revokedAt: earlier, expiresAt: earlier }, now)).toBe("revoked");
    expect(inviteStatus({ usedAt: null, revokedAt: null, expiresAt: now }, now)).toBe("expired");
    expect(inviteStatus({ usedAt: null, revokedAt: null, expiresAt: later }, now)).toBe("pending");
  });
});
