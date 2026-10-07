import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { makeCompany } from "../../../test/factories";
import { hashPassword, verifyPassword } from "./password";
import { deleteSessionByToken, findEmployerBySessionToken, insertSession } from "./session";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
  });
});

describe("sessions", () => {
  it("resolves a token to its employer and company", async () => {
    const { company, user } = await makeCompany("Globex");
    const { token } = await insertSession(user.id);
    expect(await findEmployerBySessionToken(token)).toEqual({
      userId: user.id,
      name: user.name,
      email: user.email,
      companyId: company.id,
      companyName: "Globex",
      companyWebsite: null,
      isPlatformAdmin: false,
    });
  });

  it("stores only a hash of the token", async () => {
    const { user } = await makeCompany();
    const { token } = await insertSession(user.id);
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.id === token)).toBe(false);
  });

  it("rejects unknown, deleted and expired tokens", async () => {
    const { user } = await makeCompany();
    expect(await findEmployerBySessionToken("nope")).toBeNull();

    const { token } = await insertSession(user.id);
    await deleteSessionByToken(token);
    expect(await findEmployerBySessionToken(token)).toBeNull();

    const { token: expired } = await insertSession(user.id);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, user.id));
    expect(await findEmployerBySessionToken(expired)).toBeNull();
  });

  it("clears expired sessions when a new one starts", async () => {
    const { user } = await makeCompany();
    await insertSession(user.id);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, user.id));
    const { token } = await insertSession(user.id);
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(await findEmployerBySessionToken(token)).toMatchObject({ userId: user.id });
  });
});
