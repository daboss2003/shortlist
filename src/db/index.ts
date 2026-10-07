import "server-only";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { Pool, neon } from "@neondatabase/serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleNeonPool } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

/** Driver-neutral handle. Never rely on a driver-specific result shape (e.g. rowCount): use `.returning()`. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

type DbState = { db: Db; ready: Promise<void> };

function createDb(): DbState {
  const url = process.env.DATABASE_URL;
  if (url) {
    // Production (Netlify + Neon). Migrations are applied at deploy time by `pnpm db:migrate`, never here.
    // Intentional: queries go over Neon's stateless HTTP endpoint — a pooled socket kept at module scope can be
    // handed out stale after a serverless freeze/thaw (Neon's guidance: a Pool must not outlive a request).
    // Interactive transactions need a session, so each one gets a short-lived pool that is closed right after.
    const http = drizzleNeonHttp({ client: neon(url), schema }) as unknown as Db;
    const transaction: Db["transaction"] = async (fn, config) => {
      const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
      pool.on("error", (err: Error) => console.error("[db] pool client error:", err.message));
      try {
        return await (drizzleNeonPool({ client: pool, schema }) as unknown as Db).transaction(fn, config);
      } finally {
        await pool.end().catch(() => undefined);
      }
    };
    const db = new Proxy(http, {
      get: (target, prop, receiver) => (prop === "transaction" ? transaction : Reflect.get(target, prop, receiver)),
    });
    return { db, ready: Promise.resolve() };
  }

  // Local dev and tests: embedded Postgres (PGlite) — no account, server or Docker needed.
  const dir = process.env.PGLITE_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "pglite");
  if (dir !== "memory://") {
    fs.mkdirSync(dir, { recursive: true });
    claimLocalDbLock(dir);
  }
  const db = drizzlePglite({ client: new PGlite(dir === "memory://" ? undefined : dir), schema }) as unknown as Db;
  const ready = migratePglite(db as never, {
    migrationsFolder: path.join(/*turbopackIgnore: true*/ process.cwd(), "drizzle"),
  });
  return { db, ready };
}

/**
 * PGlite can't be shared between processes: a second process (e.g. `pnpm invite` while `pnpm dev` runs) would write
 * changes this one never sees and later overwrites. Record our pid so tools can refuse instead of losing data.
 */
function claimLocalDbLock(dir: string) {
  const lockFile = path.join(dir, ".app.lock");
  try {
    fs.writeFileSync(lockFile, String(process.pid));
    process.once("exit", () => {
      try {
        if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.rmSync(lockFile);
      } catch {
        // Intentional: best effort; a stale lock with a dead pid is ignored by readers.
      }
    });
  } catch (err) {
    console.error("[db] could not write the local database lock:", err instanceof Error ? err.message : err);
  }
}

// Intentional: cached on globalThis so dev hot reloads and Next's per-bundle module copies share one pool.
const globalForDb = globalThis as unknown as { __cvDb?: DbState };
const state = (): DbState => (globalForDb.__cvDb ??= createDb());

/**
 * Lazy handle: nothing connects merely by importing this module, so `next build` never touches a database.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const instance = state().db;
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

/** Resolves once the local (PGlite) schema is migrated. A no-op in production. Await before the first query. */
export function ensureDbReady(): Promise<void> {
  return state().ready;
}

/**
 * Startup sanity check for a hosted database (DATABASE_URL): returns a human instruction when Shortlist's tables are
 * missing, else null. Read-only. PGlite migrates itself, so it's never reported there.
 */
export async function findSchemaProblem(): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  const result = await db.execute(
    sql`select to_regclass('public.candidates') is not null as ours,
          (select count(*)::int from information_schema.tables where table_schema = 'public') as tables`,
  );
  const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as
    | { ours: boolean; tables: number }
    | undefined;
  if (!row || row.ours) return null;
  return row.tables > 0
    ? "DATABASE_URL points at a database that belongs to something else (it has other tables but no Shortlist " +
        "tables). Give Shortlist its own Neon database, then run `pnpm db:migrate`."
    : "The database at DATABASE_URL has no tables yet. Run `pnpm db:migrate` (on Netlify it runs during the " +
        "production build).";
}
