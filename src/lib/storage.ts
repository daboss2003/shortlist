import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import type { CvFileType } from "@/lib/cv/file-type";
import { isNetlify } from "@/lib/pipeline/runtime";

// CV file storage. Keys are server-generated (uuid + extension); user-supplied file names never reach a path or a
// blob key. Two drivers, chosen by STORAGE_DRIVER:
// - "netlify-blobs": the "cvs" Netlify Blobs store. Default on Netlify, whose functions have no persistent disk.
// - "local": files under UPLOAD_DIR (default ./data/uploads). Default everywhere else.

const KEY_PATTERN = /^[0-9a-f-]{36}\.(pdf|docx|doc|txt)$/;
const BLOB_STORE_NAME = "cvs";

export type StorageDriverName = "netlify-blobs" | "local";

/** The CV file isn't stored. `code` matches Node's, so callers can treat both drivers alike. */
export class CvFileMissingError extends Error {
  readonly code = "ENOENT";
  constructor() {
    super("CV file not found");
  }
}

type Driver = {
  write(key: string, bytes: Buffer): Promise<void>;
  /** null when missing. */
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
};

export function storageDriverName(): StorageDriverName {
  const configured = process.env.STORAGE_DRIVER?.trim();
  if (!configured) return isNetlify() ? "netlify-blobs" : "local";
  if (configured === "netlify-blobs" || configured === "local") return configured;
  // Intentional: thrown, not defaulted — silently writing CVs to a serverless function's throwaway disk loses them.
  throw new Error('STORAGE_DRIVER must be "netlify-blobs" or "local"');
}

function driver(): Driver {
  return storageDriverName() === "netlify-blobs" ? blobsDriver : localDriver;
}

function checkKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
  return key;
}

export async function saveCvFile(bytes: Buffer, fileType: CvFileType): Promise<string> {
  const key = checkKey(`${crypto.randomUUID()}.${fileType}`);
  await driver().write(key, bytes);
  return key;
}

/** Throws CvFileMissingError (code "ENOENT") when the file isn't stored. */
export async function readCvFile(key: string): Promise<Buffer> {
  const bytes = await driver().read(checkKey(key));
  if (!bytes) throw new CvFileMissingError();
  return bytes;
}

export async function deleteCvFile(key: string): Promise<void> {
  // Intentional: a missing file is not an error — deletion must be idempotent.
  await driver().remove(checkKey(key));
}

export async function cvFileExists(key: string): Promise<boolean> {
  return driver().exists(checkKey(key));
}

// ── Local disk ──

// Intentional: turbopackIgnore — uploads are runtime data, not code; without it the build traces the whole project.
const uploadDir = () => process.env.UPLOAD_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "uploads");
const localPath = (key: string) => path.join(/*turbopackIgnore: true*/ uploadDir(), key);
const isMissing = (err: unknown) => (err as { code?: string } | null)?.code === "ENOENT";

const localDriver: Driver = {
  async write(key, bytes) {
    await fs.mkdir(uploadDir(), { recursive: true });
    await fs.writeFile(localPath(key), bytes, { flag: "wx" });
  },
  async read(key) {
    try {
      return await fs.readFile(/*turbopackIgnore: true*/ localPath(key));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },
  async remove(key) {
    await fs.rm(localPath(key), { force: true });
  },
  async exists(key) {
    try {
      await fs.access(localPath(key));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  },
};

// ── Netlify Blobs ──

// Loaded on first use, so local mode never imports it.
async function blobStore() {
  const { getStore } = await import("@netlify/blobs");
  // Intentional: default (eventual) consistency. Only updates and deletes propagate lazily; a new blob is readable
  // everywhere at once, and keys are never rewritten (each upload gets a fresh uuid key).
  return getStore(BLOB_STORE_NAME);
}

const blobsDriver: Driver = {
  async write(key, bytes) {
    const store = await blobStore();
    // Intentional: no `onlyIfNew` (the local driver's "wx"). @netlify/blobs reports a conditional write as
    // successful for any status but 412, so a failed upload would pass silently; an unconditional set throws on
    // failure, and a random-uuid key can't already exist.
    await store.set(key, new Uint8Array(bytes).buffer);
  },
  async read(key) {
    const store = await blobStore();
    // The typings promise an ArrayBuffer, but a missing key resolves to null.
    const data = (await store.get(key, { type: "arrayBuffer" })) as ArrayBuffer | null;
    return data ? Buffer.from(data) : null;
  },
  async remove(key) {
    const store = await blobStore();
    await store.delete(key);
  },
  async exists(key) {
    const store = await blobStore();
    return (await store.getMetadata(key)) !== null;
  },
};
