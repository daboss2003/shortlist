import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cvFileExists, deleteCvFile, readCvFile, saveCvFile, storageDriverName } from "./storage";

// An in-memory stand-in for one Netlify Blobs store, with the library's real return shapes.
const blobs = vi.hoisted(() => {
  const data = new Map<string, ArrayBuffer>();
  const getStore = vi.fn((name: string) => ({
    name,
    set: vi.fn(async (key: string, value: ArrayBuffer) => {
      data.set(key, value);
      return { modified: true, etag: "e" };
    }),
    get: vi.fn(async (key: string, opts?: { type?: string }) => {
      if (opts?.type !== "arrayBuffer") throw new Error("expected an arrayBuffer read");
      return data.get(key) ?? null;
    }),
    getMetadata: vi.fn(async (key: string) => (data.has(key) ? { etag: "e", metadata: {} } : null)),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  }));
  return { data, getStore };
});

vi.mock("@netlify/blobs", () => ({ getStore: blobs.getStore }));

const tmpDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  blobs.data.clear();
  blobs.getStore.mockClear();
});
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("storageDriverName", () => {
  it("defaults to Netlify Blobs on Netlify and to local disk elsewhere", () => {
    expect(storageDriverName()).toBe("local");
    vi.stubEnv("NETLIFY", "true");
    expect(storageDriverName()).toBe("netlify-blobs");
  });

  it("follows STORAGE_DRIVER over the default", () => {
    vi.stubEnv("NETLIFY", "true");
    vi.stubEnv("STORAGE_DRIVER", "local");
    expect(storageDriverName()).toBe("local");
    vi.stubEnv("NETLIFY", "");
    vi.stubEnv("STORAGE_DRIVER", "netlify-blobs");
    expect(storageDriverName()).toBe("netlify-blobs");
  });

  it("refuses an unknown STORAGE_DRIVER instead of guessing", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    expect(() => storageDriverName()).toThrow(/STORAGE_DRIVER/);
    await expect(saveCvFile(Buffer.from("x"), "txt")).rejects.toThrow(/STORAGE_DRIVER/);
  });
});

describe.each(["local", "netlify-blobs"] as const)("%s driver", (driverName) => {
  let dir: string;

  beforeEach(() => {
    vi.stubEnv("STORAGE_DRIVER", driverName);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvp-storage-"));
    tmpDirs.push(dir);
    vi.stubEnv("UPLOAD_DIR", dir);
  });

  it("round-trips the bytes under a fresh uuid key with the file type as extension", async () => {
    const bytes = Buffer.from("%PDF-1.4 binary \u0000ÿ bytes");
    const key = await saveCvFile(bytes, "pdf");

    expect(key).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(await readCvFile(key)).toEqual(bytes);
    expect(await cvFileExists(key)).toBe(true);
    expect(await saveCvFile(bytes, "pdf")).not.toBe(key);
  });

  it("keeps the bytes it was given even if the caller's buffer is reused", async () => {
    const bytes = Buffer.from("original");
    const key = await saveCvFile(bytes, "txt");
    bytes.write("CHANGED!");
    expect((await readCvFile(key)).toString()).toBe("original");
  });

  it("throws an ENOENT error for a missing file, and reports it as not existing", async () => {
    const key = `${crypto.randomUUID()}.docx`;
    await expect(readCvFile(key)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cvFileExists(key)).toBe(false);
  });

  it("deletes idempotently", async () => {
    const key = await saveCvFile(Buffer.from("cv"), "txt");
    await deleteCvFile(key);
    await deleteCvFile(key);
    expect(await cvFileExists(key)).toBe(false);
    await expect(readCvFile(key)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../etc/passwd", "a.pdf", `${crypto.randomUUID()}.exe`, `${crypto.randomUUID()}.pdf/../x`, ""])(
    "rejects the malformed key %j before touching storage",
    async (key) => {
      await expect(readCvFile(key)).rejects.toThrow("Invalid storage key");
      await expect(deleteCvFile(key)).rejects.toThrow("Invalid storage key");
      await expect(cvFileExists(key)).rejects.toThrow("Invalid storage key");
      expect(blobs.getStore).not.toHaveBeenCalled();
    },
  );

  it("stores where the driver says", async () => {
    const key = await saveCvFile(Buffer.from("cv"), "txt");
    expect(fs.existsSync(path.join(dir, key))).toBe(driverName === "local");
    expect(blobs.data.has(key)).toBe(driverName === "netlify-blobs");
    if (driverName === "netlify-blobs") expect(blobs.getStore).toHaveBeenCalledWith("cvs");
  });
});
