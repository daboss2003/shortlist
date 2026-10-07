import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db";
import { companies, sessions, users } from "@/db/schema";

export const SESSION_COOKIE = "cvp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type Employer = {
  userId: string;
  name: string;
  email: string;
  companyId: string;
  companyName: string;
  companyWebsite: string | null;
  /**
   * Platform operator (can invite companies). Always set from the session; optional only so test fixtures
   * written before it existed still type-check. Absent means not an admin.
   */
  isPlatformAdmin?: boolean;
};

/** Creates a session row and returns the raw token (only the hash is stored). */
export async function insertSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function findEmployerBySessionToken(token: string): Promise<Employer | null> {
  const [row] = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      companyId: companies.id,
      companyName: companies.name,
      companyWebsite: companies.website,
      isPlatformAdmin: users.isPlatformAdmin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(companies, eq(companies.id, users.companyId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Starts a session for the user and sets the cookie. Call from a Server Action or Route Handler. */
export async function startSession(userId: string): Promise<void> {
  const { token, expiresAt } = await insertSession(userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSessionByToken(token);
  store.delete(SESSION_COOKIE);
}
