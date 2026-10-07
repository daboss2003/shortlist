import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies, users } from "@/db/schema";
import { makeCompany } from "../../../test/factories";
import { hashPassword, verifyPassword } from "./password";
import { seedPlatformAdmin } from "./seed-admin";

vi.mock("./password", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./password")>();
  return { ...mod, hashPassword: vi.fn(mod.hashPassword) };
});

const PASSWORD = "a long admin password";
const userByEmail = (email: string) => db.select().from(users).where(eq(users.email, email)).get();
const userCount = () => db.select().from(users).all().length;

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function env(vars: Record<string, string>) {
  for (const key of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_NAME", "ADMIN_COMPANY_NAME"]) vi.stubEnv(key, "");
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
}

const logged = () => JSON.stringify([...info.mock.calls, ...error.mock.calls]);

describe("seedPlatformAdmin", () => {
  it("creates the admin with its own company and a scrypt hash", async () => {
    env({ ADMIN_EMAIL: " Ops@Shortlist.example ", ADMIN_PASSWORD: PASSWORD, ADMIN_NAME: "Ops", ADMIN_COMPANY_NAME: "Shortlist HQ" });
    await seedPlatformAdmin();

    const admin = userByEmail("ops@shortlist.example")!;
    expect(admin).toMatchObject({ name: "Ops", isPlatformAdmin: true });
    expect(admin.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(PASSWORD, admin.passwordHash)).toBe(true);
    expect(db.select().from(companies).where(eq(companies.id, admin.companyId)).get()!.name).toBe("Shortlist HQ");
    expect(logged()).not.toContain(PASSWORD);
  });

  it("defaults the name to Admin and the company to the app name", async () => {
    env({ ADMIN_EMAIL: "defaults@shortlist.example", ADMIN_PASSWORD: PASSWORD });
    await seedPlatformAdmin();
    const admin = userByEmail("defaults@shortlist.example")!;
    expect(admin.name).toBe("Admin");
    expect(db.select().from(companies).where(eq(companies.id, admin.companyId)).get()!.name).toBe("Shortlist");
  });

  it("is idempotent", async () => {
    env({ ADMIN_EMAIL: "twice@shortlist.example", ADMIN_PASSWORD: PASSWORD });
    await seedPlatformAdmin();
    const first = userByEmail("twice@shortlist.example")!;
    const count = userCount();
    await seedPlatformAdmin();
    expect(userCount()).toBe(count);
    expect(userByEmail("twice@shortlist.example")).toEqual(first);
  });

  it("promotes an existing account when ADMIN_PASSWORD is its password", async () => {
    const { user } = makeCompany();
    const hash = await hashPassword(PASSWORD);
    db.update(users).set({ passwordHash: hash }).where(eq(users.id, user.id)).run();
    env({ ADMIN_EMAIL: user.email.toUpperCase(), ADMIN_PASSWORD: PASSWORD });
    const count = userCount();

    await seedPlatformAdmin();

    const after = userByEmail(user.email)!;
    expect(after.isPlatformAdmin).toBe(true);
    expect(after.passwordHash).toBe(hash);
    expect(after.companyId).toBe(user.companyId);
    expect(userCount()).toBe(count);
    expect(logged()).not.toContain(PASSWORD);
  });

  it("does not promote an existing account whose password doesn't match, and leaves it untouched", async () => {
    // e.g. someone with an open invite signed up with the admin's address before ADMIN_EMAIL was set.
    const { user } = makeCompany();
    const squatterHash = await hashPassword("the squatter's own password");
    db.update(users).set({ passwordHash: squatterHash }).where(eq(users.id, user.id)).run();
    env({ ADMIN_EMAIL: user.email, ADMIN_PASSWORD: PASSWORD });
    const count = userCount();

    await seedPlatformAdmin();

    const after = userByEmail(user.email)!;
    expect(after.isPlatformAdmin).toBe(false);
    expect(after.passwordHash).toBe(squatterHash);
    expect(userCount()).toBe(count);
    expect(error).toHaveBeenCalledWith(
      "[admin] ADMIN_EMAIL belongs to an existing account whose password doesn't match ADMIN_PASSWORD — not promoted",
    );
    expect(info).not.toHaveBeenCalled();
    expect(logged()).not.toContain(PASSWORD);
  });

  it("never resets the password of an existing admin", async () => {
    env({ ADMIN_EMAIL: "rotated@shortlist.example", ADMIN_PASSWORD: PASSWORD });
    await seedPlatformAdmin();
    const original = userByEmail("rotated@shortlist.example")!.passwordHash;

    env({ ADMIN_EMAIL: "rotated@shortlist.example", ADMIN_PASSWORD: "a different long password" });
    await seedPlatformAdmin();
    expect(userByEmail("rotated@shortlist.example")!.passwordHash).toBe(original);
  });

  it("skips a password under 12 characters with an error that doesn't contain it", async () => {
    env({ ADMIN_EMAIL: "weak@shortlist.example", ADMIN_PASSWORD: "short-pw-11" });
    await seedPlatformAdmin();
    expect(userByEmail("weak@shortlist.example")).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ADMIN_PASSWORD must be at least 12 characters — admin not seeded"));
    expect(logged()).not.toContain("short-pw-11");
  });

  it("skips an invalid email or an over-long password", async () => {
    env({ ADMIN_EMAIL: "not-an-email", ADMIN_PASSWORD: PASSWORD });
    await seedPlatformAdmin();
    env({ ADMIN_EMAIL: "long@shortlist.example", ADMIN_PASSWORD: "x".repeat(201) });
    await seedPlatformAdmin();
    expect(userByEmail("not-an-email")).toBeUndefined();
    expect(userByEmail("long@shortlist.example")).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("does nothing, quietly, when the env vars are missing", async () => {
    const count = userCount();
    env({});
    await seedPlatformAdmin();
    expect(info).not.toHaveBeenCalled();
    env({ ADMIN_EMAIL: "half@shortlist.example" });
    await seedPlatformAdmin();
    env({ ADMIN_PASSWORD: PASSWORD });
    await seedPlatformAdmin();
    expect(userCount()).toBe(count);
    expect(error).not.toHaveBeenCalled();
    expect(logged()).not.toContain(PASSWORD);
  });

  it("never throws", async () => {
    env({ ADMIN_EMAIL: "boom@shortlist.example", ADMIN_PASSWORD: PASSWORD });
    vi.mocked(hashPassword).mockRejectedValueOnce(new Error("out of memory"));
    await expect(seedPlatformAdmin()).resolves.toBeUndefined();
    expect(userByEmail("boom@shortlist.example")).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Could not seed"), "out of memory");
  });
});
