#!/usr/bin/env node
// Creates a one-time signup invite and prints its link.
//   pnpm invite                       # anyone with the link can sign up
//   pnpm invite jane@acme.com         # only jane@acme.com can use it
//   pnpm invite jane@acme.com --days 7
// Plain ESM with no app imports so it runs without a build. Mirrors createInvite in src/lib/auth/invites.ts:
// keep the token format, hashing and columns in step with it.
//
// Database: Neon when DATABASE_URL is set (run `pnpm db:migrate` first); otherwise the local embedded PGlite at
// PGLITE_DIR (default ./data/pglite), migrated here first. PGlite is single-process, so this refuses to run while the
// app holds the local database (see the .app.lock written by src/db/index.ts).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE = "Usage: pnpm invite [email] [--days N]";

// Same precedence as Next: .env.local wins over .env, and real environment variables win over both.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile?.(file);
  } catch {
    // Missing file: nothing to load.
  }
}

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  let email = null;
  let days = 14;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? argv[++i] : arg.slice("--days=".length);
      days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > 365) fail("--days must be a whole number from 1 to 365.");
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    } else if (email === null) {
      email = arg.trim().toLowerCase();
      if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Not a valid email address: ${arg}`);
    } else {
      fail(`Unexpected argument: ${arg}`);
    }
  }
  return { email, days };
}

const { email, days } = parseArgs(process.argv.slice(2));

/** Refuses to touch the local PGlite database while the app (pnpm dev / start) holds it — the write would be lost. */
function assertLocalDbFree(dir) {
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(dir, ".app.lock"), "utf8"));
  } catch {
    return; // no lock: the app isn't running against this database
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0); // throws if that process no longer exists (stale lock)
  } catch {
    return;
  }
  console.error("The app is running against the local database (pid " + pid + "), which can't be shared between processes.");
  console.error("Create the invite from Dashboard → Invites while signed in as the admin, or stop the app and run this again.");
  process.exit(1);
}

/** Opens the database: { db, close }. Imports lazily so only the driver in use is loaded. */
async function openDatabase() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    const pool = new Pool({ connectionString: url });
    return { db: drizzle({ client: pool }), close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = process.env.PGLITE_DIR || "./data/pglite";
  if (dir !== "memory://") {
    assertLocalDbFree(path.resolve(dir));
    fs.mkdirSync(path.resolve(dir), { recursive: true });
  }
  const client = new PGlite(dir === "memory://" ? undefined : path.resolve(dir));
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: path.resolve("drizzle") });
  return { db, close: () => client.close() };
}

const token = randomBytes(32).toString("base64url");
const now = new Date();
const expiresAt = new Date(now.getTime() + days * DAY_MS);
const { db, close } = await openDatabase();
try {
  await db.execute(
    sql`INSERT INTO invites (id, token_hash, email, expires_at, created_at)
        VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")}, ${email},
                ${expiresAt.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`,
  );
} finally {
  await close();
}

const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
console.log(`Invite created${email ? ` for ${email}` : " (anyone with the link)"}, valid for ${days} day${days === 1 ? "" : "s"}.`);
console.log(`Expires: ${expiresAt.toISOString()}`);
console.log("");
console.log(`${base}/signup?invite=${token}`);
console.log("");
console.log("Share this link privately. It works once, and only its hash is stored, so it can't be shown again.");
