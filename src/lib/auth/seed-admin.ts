import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { companies, users } from "@/db/schema";
import { APP_NAME } from "@/lib/brand";
import { hashPassword, verifyPassword } from "./password";

const MIN_PASSWORD = 12;
// Login rejects longer input before checking it, so a longer env value would make an admin who can't sign in.
const MAX_LENGTH = 200;

/**
 * Creates the platform admin from ADMIN_EMAIL / ADMIN_PASSWORD on boot, or promotes an existing account with that
 * email if ADMIN_PASSWORD is its password. ADMIN_NAME and ADMIN_COMPANY_NAME are optional. Idempotent, needs no
 * invite, and never throws.
 */
export async function seedPlatformAdmin(): Promise<void> {
  try {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      if (email || password) console.info("[admin] Set both ADMIN_EMAIL and ADMIN_PASSWORD to seed a platform admin.");
      return;
    }
    if (email.length > MAX_LENGTH || !z.email().safeParse(email).success) {
      console.error("[admin] ADMIN_EMAIL isn't a valid email address — admin not seeded");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      console.error(`[admin] ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters — admin not seeded`);
      return;
    }
    if (password.length > MAX_LENGTH) {
      console.error(`[admin] ADMIN_PASSWORD must be at most ${MAX_LENGTH} characters — admin not seeded`);
      return;
    }

    const existing = db
      .select({ id: users.id, isPlatformAdmin: users.isPlatformAdmin, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .get();
    if (existing) {
      // Intentional: create-only so env can't silently reset a password the admin may have changed.
      if (existing.isPlatformAdmin) return;
      // Emails aren't verified, so anyone with an open invite could have signed up with this address first.
      // Only promote when ADMIN_PASSWORD opens the account, i.e. the operator controls it.
      if (!(await verifyPassword(password, existing.passwordHash))) {
        console.error("[admin] ADMIN_EMAIL belongs to an existing account whose password doesn't match ADMIN_PASSWORD — not promoted");
        return;
      }
      db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, existing.id)).run();
      console.info("[admin] Existing account promoted to platform admin.");
      return;
    }

    const name = process.env.ADMIN_NAME?.trim().slice(0, 120) || "Admin";
    const companyName = process.env.ADMIN_COMPANY_NAME?.trim().slice(0, 120) || APP_NAME;
    const passwordHash = await hashPassword(password);
    db.transaction((tx) => {
      const company = tx.insert(companies).values({ name: companyName }).returning({ id: companies.id }).get();
      tx.insert(users).values({ companyId: company.id, name, email, passwordHash, isPlatformAdmin: true }).run();
    });
    console.info("[admin] Platform admin account created.");
  } catch (err) {
    console.error("[admin] Could not seed the platform admin:", err instanceof Error ? err.message : err);
  }
}
