import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import type { CvFileType } from "@/lib/cv/file-type";

// Local-disk CV storage under UPLOAD_DIR (default ./data/uploads). Keys are server-generated
// (uuid + extension); user-supplied file names never reach the filesystem path.

const KEY_PATTERN = /^[0-9a-f-]{36}\.(pdf|docx|doc|txt)$/;

// Intentional: turbopackIgnore — uploads are runtime data, not code; without it the build traces the whole project.
const uploadDir = () => process.env.UPLOAD_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "uploads");

function keyPath(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
  return path.join(/*turbopackIgnore: true*/ uploadDir(), key);
}

export async function saveCvFile(bytes: Buffer, fileType: CvFileType): Promise<string> {
  const key = `${crypto.randomUUID()}.${fileType}`;
  await fs.mkdir(uploadDir(), { recursive: true });
  await fs.writeFile(keyPath(key), bytes, { flag: "wx" });
  return key;
}

export async function readCvFile(key: string): Promise<Buffer> {
  return fs.readFile(/*turbopackIgnore: true*/ keyPath(key));
}

export async function deleteCvFile(key: string): Promise<void> {
  // Intentional: missing file is not an error — deletion must be idempotent.
  await fs.rm(keyPath(key), { force: true });
}
