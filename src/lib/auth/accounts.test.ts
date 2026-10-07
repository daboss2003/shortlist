import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies, invites, users } from "@/db/schema";
import { authenticate, registerCompany as registerWithInvite, signupSchema } from "./accounts";
import { INVITE_ERROR, createInvite, hashInviteToken, revokeInvite } from "./invites";
import { verifyPassword } from "./password";

vi.mock("./password", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./password")>();
  return { ...mod, verifyPassword: vi.fn(mod.verifyPassword) };
});

let n = 0;
const signup = (overrides: Record<string, unknown> = {}) => ({
  companyName: "Acme Logistics",
  website: "",
  name: "Jane Doe",
  email: `jane${++n}@acme.com`,
  password: "correct horse battery",
  ...overrides,
});

/** Signup with a fresh, valid invite — for tests that aren't about invites. */
const registerCompany = async (input: unknown) => registerWithInvite(input, (await createInvite()).token);

const counts = async () => ({
  companies: (await db.select().from(companies)).length,
  users: (await db.select().from(users)).length,
});
const inviteRow = async (token: string) =>
  (await db.select().from(invites).where(eq(invites.tokenHash, hashInviteToken(token))))[0];
const userRow = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];
const companyRow = async (id: string) => (await db.select().from(companies).where(eq(companies.id, id)))[0];
const INVITE_FAILED = { ok: false, fieldErrors: {}, formError: INVITE_ERROR };

describe("registerCompany", () => {
  it("creates the company and its first user with a hashed password", async () => {
    const result = await registerCompany(signup({ companyName: "  Acme Logistics  ", email: " Jane.Owner@Acme.COM " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const user = await userRow(result.userId);
    const company = await companyRow(user.companyId);
    expect(company.name).toBe("Acme Logistics");
    expect(user).toMatchObject({ name: "Jane Doe", email: "jane.owner@acme.com" });
    expect(user.passwordHash).not.toContain("correct horse battery");
    expect(user.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", user.passwordHash)).toBe(true);
  });

  it("normalizes the company website", async () => {
    const result = await registerCompany(signup({ website: "acme.com" }));
    if (!result.ok) throw new Error("expected signup to succeed");
    const user = await userRow(result.userId);
    expect((await companyRow(user.companyId)).website).toBe("https://acme.com");
  });

  it("rejects a duplicate email case-insensitively and leaves no orphan company", async () => {
    await registerCompany(signup({ email: "Taken@Acme.com" }));
    const before = await counts();

    const result = await registerCompany(signup({ companyName: "Other Co", email: "taken@ACME.com" }));
    expect(result).toEqual({ ok: false, fieldErrors: { email: "An account with this email already exists." } });
    expect(await counts()).toEqual(before);
  });

  it("returns field errors for invalid input without writing anything", async () => {
    const before = await counts();
    const result = await registerCompany(
      signup({ companyName: "A", name: "  ", email: "not-an-email", password: "short", website: "ftp://acme.com" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(["companyName", "email", "name", "password", "website"]);
    expect(await counts()).toEqual(before);
  });
});

describe("registerCompany invites", () => {
  it("redeems an invite once and records who used it", async () => {
    const { token } = await createInvite();
    const result = await registerWithInvite(signup(), token);
    if (!result.ok) throw new Error("expected signup to succeed");
    expect(await inviteRow(token)).toMatchObject({ usedByUserId: result.userId });
    expect((await inviteRow(token)).usedAt).toBeInstanceOf(Date);

    const before = await counts();
    expect(await registerWithInvite(signup(), token)).toEqual(INVITE_FAILED);
    expect(await counts()).toEqual(before);
  });

  it("rejects a missing, malformed or unknown invite without writing anything", async () => {
    const before = await counts();
    for (const token of [undefined, "", "short", "x".repeat(5000), "A".repeat(43)]) {
      expect(await registerWithInvite(signup(), token)).toEqual(INVITE_FAILED);
    }
    expect(await counts()).toEqual(before);
  });

  it("rejects an expired invite", async () => {
    const { token } = await createInvite();
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.tokenHash, hashInviteToken(token)));
    const before = await counts();
    expect(await registerWithInvite(signup(), token)).toEqual(INVITE_FAILED);
    expect(await counts()).toEqual(before);
    expect((await inviteRow(token)).usedAt).toBeNull();
  });

  it("rejects a revoked invite without creating a company or user", async () => {
    const { id, token } = await createInvite();
    expect(await revokeInvite(id)).toBe(true);
    const before = await counts();
    expect(await registerWithInvite(signup(), token)).toEqual(INVITE_FAILED);
    expect(await counts()).toEqual(before);
    expect((await inviteRow(token)).usedAt).toBeNull();
  });

  it("only accepts the invited email (any casing) for an email-bound invite", async () => {
    const { token } = await createInvite({ email: "Invited@Acme.com" });
    const before = await counts();
    expect(await registerWithInvite(signup({ email: "someone.else@acme.com" }), token)).toEqual(INVITE_FAILED);
    expect(await counts()).toEqual(before);

    const result = await registerWithInvite(signup({ email: " INVITED@acme.com " }), token);
    expect(result.ok).toBe(true);
  });

  it("returns field errors for a valid invite and leaves the invite unused", async () => {
    const { token } = await createInvite();
    const result = await registerWithInvite(signup({ password: "short" }), token);
    expect(result).toMatchObject({ ok: false, fieldErrors: { password: expect.any(String) } });
    expect((await inviteRow(token)).usedAt).toBeNull();
  });

  it("rolls back the company and user when the invite is used up mid-signup", async () => {
    // Both pass the early check before either transaction runs (the password hash is awaited in between),
    // so the second one fails at redemption inside its transaction and must leave nothing behind.
    const { token } = await createInvite();
    const before = await counts();
    const [a, b] = await Promise.all([
      registerWithInvite(signup({ email: "race-a@acme.com" }), token),
      registerWithInvite(signup({ email: "race-b@acme.com" }), token),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual(INVITE_FAILED);
    expect(await counts()).toEqual({ companies: before.companies + 1, users: before.users + 1 });
    const loser = a.ok ? "race-b@acme.com" : "race-a@acme.com";
    expect(await db.select().from(users).where(eq(users.email, loser))).toEqual([]);
  });

  it("keeps the invite unused when the email is already taken", async () => {
    await registerCompany(signup({ email: "dupe@acme.com" }));
    const { token } = await createInvite();
    const before = await counts();
    const result = await registerWithInvite(signup({ email: "dupe@acme.com" }), token);
    expect(result).toEqual({ ok: false, fieldErrors: { email: "An account with this email already exists." } });
    expect((await inviteRow(token)).usedAt).toBeNull();
    expect(await counts()).toEqual(before);
  });
});

describe("signupSchema website", () => {
  const website = (value: unknown) => {
    const r = signupSchema.safeParse(signup({ website: value }));
    return r.success ? r.data.website : "invalid";
  };

  it("adds https:// to a bare domain and keeps an explicit http(s) scheme", () => {
    expect(website("acme.com")).toBe("https://acme.com");
    expect(website("  www.Acme.com/careers  ")).toBe("https://www.acme.com/careers");
    expect(website("http://acme.com/")).toBe("http://acme.com");
    expect(website("HTTPS://acme.co.uk")).toBe("https://acme.co.uk");
  });

  it("treats empty or missing as no website", () => {
    expect(website("")).toBeNull();
    expect(website("   ")).toBeNull();
    expect(website(undefined)).toBeNull();
  });

  it("rejects non-http(s) schemes, credentials and things that aren't domains", () => {
    expect(website("ftp://acme.com")).toBe("invalid");
    expect(website("javascript:alert(1)")).toBe("invalid");
    expect(website("mailto:jane@acme.com")).toBe("invalid");
    expect(website("https://user:pass@acme.com")).toBe("invalid");
    expect(website("acme")).toBe("invalid");
    expect(website("not a website")).toBe("invalid");
    expect(website(`${"a".repeat(200)}.com`)).toBe("invalid");
  });
});

describe("authenticate", () => {
  it("returns the user id for the right password, with any email casing or padding", async () => {
    const result = await registerCompany(signup({ email: "login@acme.com" }));
    if (!result.ok) throw new Error("expected signup to succeed");
    expect(await authenticate("login@acme.com", "correct horse battery")).toBe(result.userId);
    expect(await authenticate("  LOGIN@Acme.com ", "correct horse battery")).toBe(result.userId);
  });

  it("returns null for a wrong password", async () => {
    await registerCompany(signup({ email: "wrongpw@acme.com" }));
    expect(await authenticate("wrongpw@acme.com", "correct horse battery!")).toBeNull();
    expect(await authenticate("wrongpw@acme.com", "")).toBeNull();
  });

  it("returns null for an unknown email but still runs a full password check", async () => {
    vi.mocked(verifyPassword).mockClear();
    expect(await authenticate("nobody@acme.com", "correct horse battery")).toBeNull();
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    const [, stored] = vi.mocked(verifyPassword).mock.calls[0];
    // Same scrypt parameters and key length as a real hash, so the timing matches.
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]{88}$/);
  });
});
