import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

function createDb(): Db {
  const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  // Idempotent; runs on first import so dev, `next start` and tests all get an up-to-date schema.
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

// Intentional: cache on globalThis so Next dev hot-reloads don't open a new SQLite handle per edit.
const globalForDb = globalThis as unknown as { __cvDb?: Db };
export const db: Db = globalForDb.__cvDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.__cvDb = db;
