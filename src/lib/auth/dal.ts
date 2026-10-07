import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, findEmployerBySessionToken, type Employer } from "./session";

export type { Employer };

/** The signed-in employer for this request, or null. Deduped per request. */
export const getCurrentEmployer = cache(async (): Promise<Employer | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  // Intentional: cookies() alone still allows a runtime prefetch, where the session-expiry check's
  // `new Date()` is rejected. connection() pins this (and every tenant read after it) to the real request.
  await connection();
  return token ? findEmployerBySessionToken(token) : null;
});

/** For pages and Server Actions: redirects to /login when signed out. */
export async function requireEmployer(): Promise<Employer> {
  const employer = await getCurrentEmployer();
  if (!employer) redirect("/login");
  return employer;
}
