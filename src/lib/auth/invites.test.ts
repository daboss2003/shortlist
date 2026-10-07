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
const row = async (id: string) => (await db.select().from(invites).where(eq(invites.id, id)))[0];
const redeem = (token: string, userId: string, email: string, now?: Date) =>
  db.transaction((tx) => redeemInvite(tx, token, userId, email, now));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createInvite", () => {
  it("returns a 32-byte base64url token and stores only its sha256", async () => {
    const invite = await createInvite();
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(invite.token, "base64url")).toHaveLength(32);

    const stored = await row(invite.id);
    expect(stored.tokenHash).toBe(createHash("sha256").update(invite.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(invite.token);
    expect(stored).toMatchObject({ email: null, usedAt: null, revokedAt: null, createdByUserId: null });
  });

  it("builds the signup URL from APP_URL, defaulting to localhost", async () => {
    vi.stubEnv("APP_URL", "");
    const local = await createInvite();
    expect(local.url).toBe(`http://localhost:3000/signup?invite=${local.token}`);

    vi.stubEnv("APP_URL", "https://hire.example.com/");
    const prod = await createInvite();
    expect(prod.url).toBe(`https://hire.example.com/signup?invite=${prod.token}`);
  });

  it("expires after 14 days by default, or the given number of days", async () => {
    const before = Date.now();
    expect((await createInvite()).expiresAt.getTime()).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect((await createInvite()).expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    expect((await createInvite({ days: 7 })).expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    await expect(createInvite({ days: 0 })).rejects.toThrow();
    await expect(createInvite({ days: Number.NaN })).rejects.toThrow();
  });

  it("lowercases the email, and records who created it", async () => {
    const { user } = await makeCompany();
    const invite = await createInvite({ email: "  Jane@Acme.COM ", createdByUserId: user.id });
    expect(await row(invite.id)).toMatchObject({ email: "jane@acme.com", createdByUserId: user.id });
    expect(invite.email).toBe("jane@acme.com");
  });

  it("makes a new token every time", async () => {
    expect((await createInvite()).token).not.toBe((await createInvite()).token);
  });
});

describe("findUsableInvite", () => {
  it("finds an unused, unexpired invite by its raw token", async () => {
    const invite = await createInvite({ email: "a@b.co" });
    expect(await findUsableInvite(invite.token)).toMatchObject({ id: invite.id, email: "a@b.co" });
  });

  it("returns null for unknown, malformed, expired, used and revoked invites", async () => {
    expect(await findUsableInvite(undefined)).toBeNull();
    expect(await findUsableInvite("")).toBeNull();
    expect(await findUsableInvite("x".repeat(10_000))).toBeNull();
    expect(await findUsableInvite("A".repeat(43))).toBeNull();

    const expired = await createInvite({ days: 1 });
    expect(await findUsableInvite(expired.token, new Date(Date.now() + 2 * DAY))).toBeNull();

    const { user } = await makeCompany();
    const used = await createInvite();
    expect(await redeem(used.token, user.id, user.email)).toBe(true);
    expect(await findUsableInvite(used.token)).toBeNull();

    const revoked = await createInvite();
    await revokeInvite(revoked.id);
    expect(await findUsableInvite(revoked.token)).toBeNull();
  });

  it("doesn't match on the hash itself", async () => {
    const invite = await createInvite();
    expect(await findUsableInvite(hashInviteToken(invite.token))).toBeNull();
  });
});

describe("redeemInvite", () => {
  it("works once", async () => {
    const { user } = await makeCompany();
    const invite = await createInvite();
    expect(await redeem(invite.token, user.id, user.email)).toBe(true);
    expect(await row(invite.id)).toMatchObject({ usedByUserId: user.id });
    expect(await redeem(invite.token, user.id, user.email)).toBe(false);
  });

  it("lets only one of two parallel redemptions win", async () => {
    const { user } = await makeCompany();
    const invite = await createInvite();
    const results = await Promise.all([
      redeem(invite.token, user.id, user.email),
      redeem(invite.token, user.id, user.email),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it("refuses an expired, revoked or other-email invite", async () => {
    const { user } = await makeCompany();
    const expired = await createInvite({ days: 1 });
    expect(await redeem(expired.token, user.id, user.email, new Date(Date.now() + 2 * DAY))).toBe(false);

    const revoked = await createInvite();
    await revokeInvite(revoked.id);
    expect(await redeem(revoked.token, user.id, user.email)).toBe(false);

    const bound = await createInvite({ email: "invited@acme.com" });
    expect(await redeem(bound.token, user.id, "other@acme.com")).toBe(false);
    expect(await redeem(bound.token, user.id, "invited@acme.com")).toBe(true);

    expect((await row(expired.id)).usedAt).toBeNull();
    expect((await row(revoked.id)).usedAt).toBeNull();
  });
});

describe("revokeInvite", () => {
  it("revokes a pending invite once", async () => {
    const invite = await createInvite();
    expect(await revokeInvite(invite.id)).toBe(true);
    expect((await row(invite.id)).revokedAt).toBeInstanceOf(Date);
    expect(await revokeInvite(invite.id)).toBe(false);
  });

  it("can't revoke a used invite or a missing one", async () => {
    const { user } = await makeCompany();
    const invite = await createInvite();
    await redeem(invite.token, user.id, user.email);
    expect(await revokeInvite(invite.id)).toBe(false);
    expect((await row(invite.id)).revokedAt).toBeNull();
    expect(await revokeInvite(crypto.randomUUID())).toBe(false);
  });
});

describe("listInvites", () => {
  it("lists every invite newest first with its status and the redeeming company", async () => {
    const now = new Date();
    const { company, user } = await makeCompany("Globex Hiring");

    const pending = await createInvite({ email: "p@acme.com" });
    const used = await createInvite();
    await redeem(used.token, user.id, user.email);
    const revoked = await createInvite();
    await revokeInvite(revoked.id);
    const expired = await createInvite({ days: 1 });
    await db.update(invites).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(invites.id, expired.id));

    const list = await listInvites(now);
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

  it("still shows a used invite as used after the account is deleted", async () => {
    const { user } = await makeCompany();
    const invite = await createInvite();
    await redeem(invite.token, user.id, user.email);
    await db.delete(users).where(eq(users.id, user.id));
    expect((await listInvites()).find((i) => i.id === invite.id)).toMatchObject({ status: "used", usedByCompanyName: null });
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
