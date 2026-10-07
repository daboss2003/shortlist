import "server-only";
import { db } from "@/db";
import { candidates, type Candidate, type CandidateSource } from "@/db/schema";
import { CV_MIME_TYPES, MAX_CV_BYTES, detectCvFileType, type CvFileType } from "@/lib/cv/file-type";
import { deleteCvFile, saveCvFile } from "@/lib/storage";

// Shared by the public apply route and the employer bulk-upload route. This only stores;
// callers then call scheduleCandidateProcessing() from @/lib/pipeline.

/** Message is safe to show to the end user. */
export class CvValidationError extends Error {}

/** A public applicant already applied to this job with this email. */
export class DuplicateApplicationError extends Error {}

export type ValidatedCv = {
  bytes: Buffer;
  fileName: string;
  fileType: CvFileType;
  mimeType: string;
  size: number;
};

const MAX_MB = MAX_CV_BYTES / (1024 * 1024);

/** Checks size, emptiness and real file type by magic bytes. Throws CvValidationError. */
export async function validateCvUpload(file: File): Promise<ValidatedCv> {
  const fileName = sanitizeFileName(file.name || "cv");
  if (file.size === 0) throw new CvValidationError(`${fileName} is empty.`);
  if (file.size > MAX_CV_BYTES) throw new CvValidationError(`${fileName} is larger than ${MAX_MB} MB.`);

  const bytes = Buffer.from(await file.arrayBuffer());
  const fileType = detectCvFileType(bytes, fileName);
  if (!fileType) {
    throw new CvValidationError(`${fileName} isn't a supported CV. Upload a PDF, Word (.docx) or plain-text file.`);
  }
  return { bytes, fileName, fileType, mimeType: CV_MIME_TYPES[fileType], size: bytes.length };
}

export type CreateCandidateInput = {
  job: { id: string; companyId: string };
  source: CandidateSource;
  cv: ValidatedCv;
  /** Required for source "public"; omitted for "upload" (filled from the AI profile later). */
  applicant?: { name: string; email: string; phone: string | null };
};

/** Saves the file and inserts a `pending` candidate. Throws DuplicateApplicationError for a repeat public email. */
export async function createCandidateFromCv(input: CreateCandidateInput): Promise<Candidate> {
  const { job, source, cv, applicant } = input;
  if (source === "public" && !applicant) throw new Error("Public applications require applicant details");

  const key = await saveCvFile(cv.bytes, cv.fileType);
  try {
    return db
      .insert(candidates)
      .values({
        jobId: job.id,
        companyId: job.companyId,
        source,
        name: applicant?.name ?? null,
        email: applicant?.email.toLowerCase() ?? null,
        phone: applicant?.phone ?? null,
        cvFileKey: key,
        cvFileName: cv.fileName,
        cvMimeType: cv.mimeType,
        cvSize: cv.size,
        status: "pending",
      })
      .returning()
      .get();
  } catch (err) {
    await deleteCvFile(key);
    if (isUniqueViolation(err)) {
      throw new DuplicateApplicationError("You've already applied for this role with this email address.");
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** Keep the original name for display/download only: strip paths and control chars, cap length. */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "cv";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return (clean || "cv").slice(0, 200);
}
