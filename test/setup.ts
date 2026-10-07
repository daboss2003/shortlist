import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH = ":memory:";
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cvp-test-uploads-"));
// Tests must never hit a real AI provider.
for (const key of ["AI_PROVIDER", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"]) {
  delete process.env[key];
}
