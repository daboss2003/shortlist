// Applies drizzle/ migrations to the production database (Neon). Runs in the Netlify build command, so the
// schema is migrated before the new code goes live. Local dev (PGlite) migrates itself on startup instead.
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

try {
  process.loadEnvFile?.(".env.local");
} catch {}

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("[migrate] DATABASE_URL not set — skipping (local dev uses embedded PGlite).");
  process.exit(0);
}

const pool = new Pool({ connectionString: url });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  console.log("[migrate] Database is up to date.");
} catch (err) {
  console.error("[migrate] Failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
