import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Embedded Postgres in memory; each test file gets a migrated, isolated database.
delete process.env.DATABASE_URL;
process.env.PGLITE_DIR = "memory://";
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cvp-test-uploads-"));
// Tests must never hit a real AI provider, Inngest or Netlify Blobs.
for (const key of [
  "AI_PROVIDER",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "NETLIFY",
  "STORAGE_DRIVER",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
]) {
  delete process.env[key];
}

const { ensureDbReady } = await import("@/db");
await ensureDbReady();
