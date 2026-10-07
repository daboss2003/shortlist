import "server-only";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
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
    const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000 });
    // Intentional: Neon closes idle connections; without a listener that error would crash the function.
    pool.on("error", (err: Error) => console.error("[db] idle client error:", err.message));
    return { db: drizzleNeon({ client: pool, schema }) as unknown as Db, ready: Promise.resolve() };
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
