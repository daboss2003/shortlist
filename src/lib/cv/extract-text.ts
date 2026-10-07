import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import type { CvFileType } from "@/lib/cv/file-type";

const TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 4000;

// Intentional: turbopackIgnore — the script runs in a child node process at runtime; it must not be bundled or traced.
const extractorScript = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "extract-cv-text.mjs");

/**
 * Plain text of a CV file, normalized for the AI prompt. Parsing runs in a separate, memory- and time-limited
 * node process (scripts/extract-cv-text.mjs), so a malicious file can't freeze or crash the server.
 * Throws if the file can't be parsed.
 */
export async function extractCvText(bytes: Buffer, fileType: CvFileType): Promise<string> {
  return runCvExtractor(bytes, fileType, { scriptPath: extractorScript(), timeoutMs: TIMEOUT_MS });
}

/** The process plumbing behind extractCvText. Exported so tests can point it at a stub script. */
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
      if (stdoutBytes > MAX_STDOUT_BYTES) kill("produced too much output");
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
