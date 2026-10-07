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

function signIn({ admin }: { admin: boolean }) {
  const { user } = makeCompany();
  if (admin) db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id)).run();
  mocks.token = insertSession(user.id).token;
  return user;
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const inviteCount = () => db.select().from(invites).all().length;

beforeEach(() => {
  mocks.token = undefined;
  mocks.revalidatePath.mockClear();
});

describe("createInviteAction", () => {
  it("redirects signed-out visitors to /login and 404s non-admins, creating nothing", async () => {
    const before = inviteCount();
    await expect(createInviteAction({}, form({ email: "", days: "14" }))).rejects.toThrow("REDIRECT:/login");
    signIn({ admin: false });
    await expect(createInviteAction({}, form({ email: "", days: "14" }))).rejects.toThrow("NOT_FOUND");
    expect(inviteCount()).toBe(before);
  });

  it("creates an open invite and returns its link once", async () => {
    const admin = signIn({ admin: true });
    const state = await createInviteAction({}, form({ email: "", days: "7" }));
    const url = new URL(state.created!.url);
    const token = url.searchParams.get("invite")!;
    expect(url.pathname).toBe("/signup");

    const row = db.select().from(invites).where(eq(invites.tokenHash, hashInviteToken(token))).get()!;
    expect(row).toMatchObject({ email: null, createdByUserId: admin.id, usedAt: null, revokedAt: null });
    const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(state.created!.expiresAt).toBe(row.expiresAt.toISOString());
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/admin/invites");
  });

  it("locks the invite to a lowercased email when one is given", async () => {
    signIn({ admin: true });
    const state = await createInviteAction({}, form({ email: "  Hiring@Globex.COM ", days: "14" }));
    expect(state.created!.email).toBe("hiring@globex.com");
    const token = new URL(state.created!.url).searchParams.get("invite")!;
    expect(findUsableInvite(token)!.email).toBe("hiring@globex.com");
  });

  it("validates the email and the expiry choice", async () => {
    signIn({ admin: true });
    const before = inviteCount();
    expect(await createInviteAction({}, form({ email: "nope", days: "14" }))).toMatchObject({
      fieldErrors: { email: expect.any(String) },
      values: { email: "nope", days: "14" },
    });
    expect(await createInviteAction({}, form({ email: "", days: "365" }))).toMatchObject({
      fieldErrors: { days: "Choose when the invite expires." },
    });
    expect(inviteCount()).toBe(before);
  });

  it("refuses an email that already has an account", async () => {
    const admin = signIn({ admin: true });
    expect(await createInviteAction({}, form({ email: admin.email.toUpperCase(), days: "14" }))).toMatchObject({
      fieldErrors: { email: "An account with this email already exists." },
    });
  });
});

describe("revokeInviteAction", () => {
  it("404s non-admins and leaves the invite usable", async () => {
    const invite = createInvite();
    signIn({ admin: false });
    await expect(revokeInviteAction(invite.id)).rejects.toThrow("NOT_FOUND");
    expect(findUsableInvite(invite.token)).not.toBeNull();
  });

  it("revokes a pending invite so it can no longer be used", async () => {
    const invite = createInvite();
    signIn({ admin: true });
    await revokeInviteAction(invite.id);
    expect(findUsableInvite(invite.token)).toBeNull();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/admin/invites");
  });

  it("ignores malformed and unknown ids", async () => {
    signIn({ admin: true });
    await expect(revokeInviteAction("not-a-uuid")).resolves.toBeUndefined();
    await expect(revokeInviteAction(crypto.randomUUID())).resolves.toBeUndefined();
  });
});
