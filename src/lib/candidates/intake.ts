import "server-only";
import type { Candidate, CandidateSource } from "@/db/schema";
import type { CvFileType } from "@/lib/cv/file-type";

// CONTRACT (frozen) — implemented by the AI/pipeline workstream; used by the public apply
// route and the employer bulk-upload route. Neither caller schedules AI work itself:
// createCandidateFromCv only stores; callers then call scheduleCandidateProcessing().

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

/** Checks size (MAX_CV_BYTES), emptiness and real file type by magic bytes. Throws CvValidationError. */
export async function validateCvUpload(file: File): Promise<ValidatedCv> {
  void file;
  throw new Error("not implemented");
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
  void input;
  throw new Error("not implemented");
}
