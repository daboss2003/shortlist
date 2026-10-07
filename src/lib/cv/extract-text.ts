import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import type { CvFileType } from "@/lib/cv/file-type";
import { isNetlify } from "@/lib/pipeline/runtime";
import { extractText as extractWithCore } from "./extract-core.mjs";

const ISOLATED_TIMEOUT_MS = 30_000;
// Well under Netlify's 60 s hard limit, so a slow file fails the step instead of the platform killing it.
const INLINE_TIMEOUT_MS = 40_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 4000;

/**
 * Where parsing runs (CV_EXTRACTION):
 * - "isolated": a separate, memory- and time-limited node process (scripts/extract-cv-text.mjs), so a malicious
 *   file can't freeze or crash a long-lived server. Default on a normal server.
 * - "inline": in this process, with time and output caps. Default on serverless (Netlify, AWS Lambda), where each
 *   invocation is already isolated and a spawned script's dependencies aren't reliably shipped with the function.
 * Both run the same code (src/lib/cv/extract-core.mjs).
 */
export type ExtractionMode = "isolated" | "inline";

let warnedAboutMode = false;

export function extractionMode(): ExtractionMode {
  const configured = process.env.CV_EXTRACTION?.trim();
  if (configured === "isolated" || configured === "inline") return configured;
  if (configured && !warnedAboutMode) {
    warnedAboutMode = true;
    console.error('[cv] CV_EXTRACTION must be "isolated" or "inline"; using the default for this environment');
  }
  return isNetlify() || process.env.AWS_LAMBDA_FUNCTION_NAME ? "inline" : "isolated";
}

// Intentional: turbopackIgnore — the script runs in a child node process at runtime; it must not be bundled or traced.
const extractorScript = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "extract-cv-text.mjs");

/** Plain text of a CV file, normalized for the AI prompt. Throws if the file can't be parsed. */
export async function extractCvText(
  bytes: Buffer,
  fileType: CvFileType,
  { mode = extractionMode() }: { mode?: ExtractionMode } = {},
): Promise<string> {
  if (mode === "inline") return runInlineExtractor(bytes, fileType, { timeoutMs: INLINE_TIMEOUT_MS });
  return runCvExtractor(bytes, fileType, { scriptPath: extractorScript(), timeoutMs: ISOLATED_TIMEOUT_MS });
}

/** Parses one CV. Replaceable so tests can simulate slow or oversized parses. */
export type InlineExtract = (bytes: Buffer, fileType: CvFileType) => Promise<string>;

/**
 * Inline mode: the shared extractor in this thread, with a timeout and the isolated mode's output cap.
 *
 * Intentional: not a worker thread. Turbopack ships `new Worker(new URL("./x.mjs", import.meta.url))` as an unbundled
 * asset whose own imports (extract-core.mjs and the parser packages) don't resolve in the built server — verified
 * against `next build`: every CV failed. A static import is bundled and traced like the rest of the server, so it
 * works on Netlify. The trade-off: a parse that loses the timeout race can't be killed and runs on until it finishes;
 * the 4 MB upload cap, the DOCX expansion guard and the output caps bound how long and how much that can be.
 */
export async function runInlineExtractor(
  bytes: Buffer,
  fileType: CvFileType,
  { timeoutMs, extract = extractWithCore }: { timeoutMs: number; extract?: InlineExtract },
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`CV text extraction timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  try {
    const text = await Promise.race([extract(bytes, fileType), timedOut]);
    if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) throw new Error("CV text extraction produced too much output");
    return text;
  } catch (err) {
    if (err instanceof TimeoutError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    if (reason.startsWith("CV text extraction")) throw err;
    throw new Error(`CV text extraction failed: ${reason.replace(/\s+/g, " ").slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
  }
}

class TimeoutError extends Error {}

/** Isolated mode: the process plumbing behind extractCvText. Exported so tests can point it at a stub script. */
export function runCvExtractor(
  bytes: Buffer,
  fileType: CvFileType,
  { scriptPath, timeoutMs }: { scriptPath: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=256", scriptPath, fileType], {
      // The child gets no secrets (or NODE_OPTIONS): only what node needs. Undefined values are left out.
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let killedFor: string | null = null;

    const kill = (reason: string) => {
      killedFor ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s`), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) kill("produced too much output");
      else stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep the tail: the actual failure reason is printed last, after any library warnings.
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    // Intentional: ignored — EPIPE when the child exits before reading all its input; the exit status reports why.
    child.stdin.on("error", () => {});

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`CV text extraction could not start: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killedFor) return reject(new Error(`CV text extraction ${killedFor}`));
      if (code !== 0) {
        const reason = stderr.trim().split("\n").slice(-3).join(" ").slice(-300);
        return reject(new Error(`CV text extraction failed (${signal ?? `exit code ${code}`})${reason ? `: ${reason}` : ""}`));
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });

    child.stdin.end(bytes);
  });
}
