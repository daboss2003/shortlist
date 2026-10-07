#!/usr/bin/env node
// Creates a one-time signup invite and prints its link.
//   pnpm invite                       # anyone with the link can sign up
//   pnpm invite jane@acme.com         # only jane@acme.com can use it
//   pnpm invite jane@acme.com --days 7
// Plain ESM with no app imports so it runs without a build. Mirrors createInvite in src/lib/auth/invites.ts:
// keep the token format, hashing and columns in step with it.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

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

const file = process.env.DATABASE_PATH || "./data/app.db";
if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
const sqlite = new Database(file);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
migrate(drizzle(sqlite), { migrationsFolder: path.resolve("drizzle") });

const token = randomBytes(32).toString("base64url");
const now = Date.now();
const expiresAt = now + days * DAY_MS;
sqlite
  .prepare("INSERT INTO invites (id, token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
  .run(randomUUID(), createHash("sha256").update(token).digest("hex"), email, expiresAt, now);
sqlite.close();

const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
console.log(`Invite created${email ? ` for ${email}` : " (anyone with the link)"}, valid for ${days} day${days === 1 ? "" : "s"}.`);
console.log(`Expires: ${new Date(expiresAt).toISOString()}`);
console.log("");
console.log(`${base}/signup?invite=${token}`);
console.log("");
console.log("Share this link privately. It works once, and only its hash is stored, so it can't be shown again.");
