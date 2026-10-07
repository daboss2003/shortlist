import "server-only";
import type { CvFileType } from "@/lib/cv/file-type";

// CONTRACT (frozen) — implemented by the AI/pipeline workstream.
// Local-disk CV storage under UPLOAD_DIR (default ./data/uploads). Keys are server-generated
// (uuid + extension); user-supplied file names never reach the filesystem path.

export async function saveCvFile(bytes: Buffer, fileType: CvFileType): Promise<string> {
  void bytes;
  void fileType;
  throw new Error("not implemented");
}

export async function readCvFile(key: string): Promise<Buffer> {
  void key;
  throw new Error("not implemented");
}

export async function deleteCvFile(key: string): Promise<void> {
  void key;
  throw new Error("not implemented");
}
