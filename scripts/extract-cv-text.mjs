// Extracts the plain text of one CV in its own short-lived process, so a hostile file can only crash or
// stall this child, never the server. Spawned by src/lib/cv/extract-text.ts in "isolated" mode:
//   node --max-old-space-size=256 scripts/extract-cv-text.mjs <pdf|docx|doc|txt> < cv-file
// Writes the normalized text (UTF-8) to stdout and exits 0; on failure writes a short reason to stderr
// and exits non-zero. The extraction itself is src/lib/cv/extract-core.mjs, shared with "inline" mode.
// Plain ESM on purpose: it runs directly under node, outside the Next/TS toolchain.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const MAX_RSS_BYTES = 512 * 1024 * 1024;

/**
 * --max-old-space-size only caps the JS heap; decompressed PDF and zip streams live in off-heap buffers, and
 * a zip can lie about its sizes. A watchdog thread kills the whole process once its memory passes the cap.
 */
function startMemoryWatchdog() {
  const watchdog = new Worker(
    `const { workerData: max } = require("node:worker_threads");
     setInterval(() => {
       if (process.memoryUsage.rss() > max) {
         require("node:fs").writeSync(2, "memory limit exceeded\\n");
         process.kill(process.pid, "SIGKILL");
       }
     }, 20);`,
    { eval: true, workerData: MAX_RSS_BYTES },
  );
  watchdog.unref();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  startMemoryWatchdog();
  // stdout carries only the extracted text: library logging (pdf.js prints info via console.info) goes to stderr.
  console.log = console.info = console.debug = console.error;
  const fileType = process.argv[2];
  try {
    // Loaded after the watchdog starts, so parsing libraries count against the memory cap from the start.
    const { extractText } = await import("../src/lib/cv/extract-core.mjs");
    const bytes = await readStdin();
    const text = await extractText(bytes, fileType);
    // Exit only once stdout is flushed: pipe writes are asynchronous on some platforms.
    process.stdout.write(text, () => process.exit(0));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${reason.replace(/\s+/g, " ").slice(0, 300)}\n`, () => process.exit(1));
  }
}

// Run only when executed directly, not when imported. Real paths on both sides, because the main module's URL
// is symlink-resolved and argv[1] isn't.
function invokedPath() {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : null;
  } catch {
    return null;
  }
}
if (invokedPath() === fileURLToPath(import.meta.url)) await main();
