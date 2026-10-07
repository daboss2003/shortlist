import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies, users } from "@/db/schema";
import { authenticate, registerCompany, signupSchema } from "./accounts";
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

describe("registerCompany", () => {
  it("creates the company and its first user with a hashed password", async () => {
    const result = await registerCompany(signup({ companyName: "  Acme Logistics  ", email: " Jane.Owner@Acme.COM " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const user = db.select().from(users).where(eq(users.id, result.userId)).get()!;
    const company = db.select().from(companies).where(eq(companies.id, user.companyId)).get()!;
    expect(company.name).toBe("Acme Logistics");
    expect(user).toMatchObject({ name: "Jane Doe", email: "jane.owner@acme.com" });
    expect(user.passwordHash).not.toContain("correct horse battery");
    expect(user.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", user.passwordHash)).toBe(true);
  });

  it("normalizes the company website", async () => {
    const result = await registerCompany(signup({ website: "acme.com" }));
    if (!result.ok) throw new Error("expected signup to succeed");
    const user = db.select().from(users).where(eq(users.id, result.userId)).get()!;
    expect(db.select().from(companies).where(eq(companies.id, user.companyId)).get()!.website).toBe("https://acme.com");
  });

  it("rejects a duplicate email case-insensitively and leaves no orphan company", async () => {
    await registerCompany(signup({ email: "Taken@Acme.com" }));
    const companiesBefore = db.select().from(companies).all().length;

    const result = await registerCompany(signup({ companyName: "Other Co", email: "taken@ACME.com" }));
    expect(result).toEqual({ ok: false, fieldErrors: { email: "An account with this email already exists." } });
    expect(db.select().from(companies).all().length).toBe(companiesBefore);
  });

  it("returns field errors for invalid input without writing anything", async () => {
    const companiesBefore = db.select().from(companies).all().length;
    const result = await registerCompany(
      signup({ companyName: "A", name: "  ", email: "not-an-email", password: "short", website: "ftp://acme.com" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(["companyName", "email", "name", "password", "website"]);
    expect(db.select().from(companies).all().length).toBe(companiesBefore);
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
