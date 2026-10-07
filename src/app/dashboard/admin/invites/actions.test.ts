import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invites, users } from "@/db/schema";
import { createInvite, findUsableInvite, hashInviteToken } from "@/lib/auth/invites";
import { insertSession } from "@/lib/auth/session";
import { makeCompany } from "../../../../../test/factories";

// Runs the real session lookup and requirePlatformAdmin(); only Next's request APIs are stubbed.
const mocks = vi.hoisted(() => ({ token: undefined as string | undefined, revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "cvp_session" && mocks.token ? { name, value: mocks.token } : undefined),
  }),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const { createInviteAction, revokeInviteAction } = await import("./actions");

async function signIn({ admin }: { admin: boolean }) {
  const { user } = await makeCompany();
  if (admin) await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
  mocks.token = (await insertSession(user.id)).token;
  return user;
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const inviteCount = async () => (await db.select().from(invites)).length;

beforeEach(() => {
  mocks.token = undefined;
  mocks.revalidatePath.mockClear();
});

describe("createInviteAction", () => {
  it("redirects signed-out visitors to /login and 404s non-admins, creating nothing", async () => {
    const before = await inviteCount();
    await expect(createInviteAction({}, form({ email: "", days: "14" }))).rejects.toThrow("REDIRECT:/login");
    await signIn({ admin: false });
    await expect(createInviteAction({}, form({ email: "", days: "14" }))).rejects.toThrow("NOT_FOUND");
    expect(await inviteCount()).toBe(before);
  });

  it("creates an open invite and returns its link once", async () => {
    const admin = await signIn({ admin: true });
    const state = await createInviteAction({}, form({ email: "", days: "7" }));
    const url = new URL(state.created!.url);
    const token = url.searchParams.get("invite")!;
    expect(url.pathname).toBe("/signup");

    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hashInviteToken(token)));
    expect(row).toMatchObject({ email: null, createdByUserId: admin.id, usedAt: null, revokedAt: null });
    const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(state.created!.expiresAt).toBe(row.expiresAt.toISOString());
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/admin/invites");
  });

  it("locks the invite to a lowercased email when one is given", async () => {
    await signIn({ admin: true });
    const state = await createInviteAction({}, form({ email: "  Hiring@Globex.COM ", days: "14" }));
    expect(state.created!.email).toBe("hiring@globex.com");
    const token = new URL(state.created!.url).searchParams.get("invite")!;
    expect((await findUsableInvite(token))!.email).toBe("hiring@globex.com");
  });

  it("validates the email and the expiry choice", async () => {
    await signIn({ admin: true });
    const before = await inviteCount();
    expect(await createInviteAction({}, form({ email: "nope", days: "14" }))).toMatchObject({
      fieldErrors: { email: expect.any(String) },
      values: { email: "nope", days: "14" },
    });
    expect(await createInviteAction({}, form({ email: "", days: "365" }))).toMatchObject({
      fieldErrors: { days: "Choose when the invite expires." },
    });
    expect(await inviteCount()).toBe(before);
  });

  it("returns a field error for a NUL character in the email, creating nothing", async () => {
    await signIn({ admin: true });
    const before = await inviteCount();
    expect(await createInviteAction({}, form({ email: "hiring\u0000@globex.com", days: "14" }))).toEqual({
      fieldErrors: { email: "Contains an invalid character.", days: undefined },
      values: { email: "hiring\u0000@globex.com", days: "14" },
    });
    expect(await inviteCount()).toBe(before);
  });

  it("refuses an email that already has an account", async () => {
    const admin = await signIn({ admin: true });
    const before = await inviteCount();
    expect(await createInviteAction({}, form({ email: admin.email.toUpperCase(), days: "14" }))).toMatchObject({
      fieldErrors: { email: "An account with this email already exists." },
    });
    expect(await inviteCount()).toBe(before);
  });
});

describe("revokeInviteAction", () => {
  it("404s non-admins and leaves the invite usable", async () => {
    const invite = await createInvite();
    await signIn({ admin: false });
    await expect(revokeInviteAction(invite.id)).rejects.toThrow("NOT_FOUND");
    expect(await findUsableInvite(invite.token)).not.toBeNull();
  });

  it("revokes a pending invite so it can no longer be used", async () => {
    const invite = await createInvite();
    await signIn({ admin: true });
    await revokeInviteAction(invite.id);
    expect(await findUsableInvite(invite.token)).toBeNull();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/admin/invites");
  });

  it("ignores malformed and unknown ids", async () => {
    await signIn({ admin: true });
    await expect(revokeInviteAction("not-a-uuid")).resolves.toBeUndefined();
    await expect(revokeInviteAction(`${crypto.randomUUID()}\u0000`)).resolves.toBeUndefined();
    await expect(revokeInviteAction(crypto.randomUUID())).resolves.toBeUndefined();
  });
});
