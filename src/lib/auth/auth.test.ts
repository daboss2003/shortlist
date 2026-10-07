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
  it("resolves a token to its employer and company", () => {
    const { company, user } = makeCompany("Globex");
    const { token } = insertSession(user.id);
    expect(findEmployerBySessionToken(token)).toMatchObject({
      userId: user.id,
      companyId: company.id,
      companyName: "Globex",
    });
  });

  it("stores only a hash of the token", () => {
    const { user } = makeCompany();
    const { token } = insertSession(user.id);
    const rows = db.select().from(sessions).where(eq(sessions.userId, user.id)).all();
    expect(rows.some((r) => r.id === token)).toBe(false);
  });

  it("rejects unknown, deleted and expired tokens", () => {
    const { user } = makeCompany();
    expect(findEmployerBySessionToken("nope")).toBeNull();

    const { token } = insertSession(user.id);
    deleteSessionByToken(token);
    expect(findEmployerBySessionToken(token)).toBeNull();

    const { token: expired } = insertSession(user.id);
    db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, user.id)).run();
    expect(findEmployerBySessionToken(expired)).toBeNull();
  });
});
