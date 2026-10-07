// Applies drizzle/ migrations to the production database (Neon). Runs in the Netlify build command, so the
// schema is migrated before the new code goes live. Local dev (PGlite) migrates itself on startup instead.
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs [--force]
// Refuses to touch a database that already holds another app's tables (no Shortlist marker table) unless --force.
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

try {
  process.loadEnvFile?.(".env.local");
} catch {}

const url = process.env.DATABASE_URL;
if (!url) {
  // On a Netlify production build a missing URL is a misconfiguration: shipping would leave the site with no schema.
  if (process.env.NETLIFY === "true" && process.env.CONTEXT === "production") {
    console.error("[migrate] DATABASE_URL is not set for the Production context — set it in Netlify and redeploy.");
    process.exit(1);
  }
  console.log("[migrate] DATABASE_URL not set — skipping (local dev uses embedded PGlite).");
  process.exit(0);
}

const pool = new Pool({ connectionString: url });
try {
  const foreign = await foreignTables(pool);
  if (foreign.length > 0 && !process.argv.includes("--force")) {
    console.error(
      `[migrate] Refusing: DATABASE_URL points at a database that already has tables from something else ` +
        `(${foreign.join(", ")}${foreign.length === 8 ? ", …" : ""}) and no Shortlist tables.\n` +
        `[migrate] Shortlist needs its own database: create a new Neon project (or a new database in this one), ` +
        `point DATABASE_URL at it and run this again. Use --force only if you really mean to share this database.`,
    );
    process.exitCode = 1;
  } else {
    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
    console.log("[migrate] Database is up to date.");
  }
} catch (err) {
  console.error("[migrate] Failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}

/** Tables in `public` when Shortlist's marker table (candidates) is absent: another app's database. Read-only. */
async function foreignTables(pool) {
  const { rows } = await pool.query("select to_regclass('public.candidates') is not null as ours");
  if (rows[0].ours) return [];
  const tables = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1 limit 8",
  );
  return tables.rows.map((r) => r.table_name);
}
