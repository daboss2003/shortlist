import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

function createDb(): Db {
  const file = process.env.DATABASE_PATH ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "app.db");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  // Deleted CVs/profiles are overwritten on disk, not just unlinked — retention deletes must really erase.
  sqlite.pragma("secure_delete = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(/*turbopackIgnore: true*/ process.cwd(), "drizzle") });
  return db;
}

// Intentional: cached on globalThis so dev hot reloads and the several module copies Next creates per
// server bundle share one SQLite handle, and migrations run once per process.
const globalForDb = globalThis as unknown as { __cvDb?: Db };
const getDb = (): Db => (globalForDb.__cvDb ??= createDb());

/**
 * Lazy handle: the database is opened (and migrated) on first use at runtime, never merely by importing
 * this module — `next build` imports every route and must not create or migrate the live database.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const instance = getDb();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
