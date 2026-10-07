import { getCurrentEmployer } from "@/lib/auth/dal";
import { BodyTooLargeError, readFormDataWithLimit } from "@/lib/body-limit";
import { CvValidationError, DuplicateCvError, createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { MAX_CV_BYTES } from "@/lib/cv/file-type";
import { getJobForCompany } from "@/lib/data/jobs";
import { isSameOrigin, jsonError } from "@/lib/http";
import { scheduleCandidateProcessing } from "@/lib/pipeline";

// The client sends larger selections in batches of this size.
const MAX_UPLOAD_FILES = 10;
// Intentional: 1 MB on top of the files themselves for multipart boundaries and part headers.
const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_FILES * MAX_CV_BYTES + 1024 * 1024;
const MAX_CV_MB = MAX_CV_BYTES / (1024 * 1024);

export type UploadResult =
  | { fileName: string; ok: true; candidateId: string }
  | { fileName: string; ok: false; error: string; code?: "duplicate" };

export type UploadResponse = { results: UploadResult[]; created: number };

/** Employer bulk upload of CVs they already hold. Closed jobs take no new CVs; identical files are skipped. */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[jobId]/candidates">) {
  const employer = await getCurrentEmployer();
  if (!employer) return jsonError(401, "Your session has expired. Sign in again.");
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request blocked.");

  const { jobId } = await ctx.params;
  const job = getJobForCompany(employer.companyId, jobId);
  if (!job) return jsonError(404, "Job not found.");
  if (job.status === "closed") return jsonError(409, "This job is closed. Reopen it to add CVs.");

  let form: FormData;
  try {
    form = await readFormDataWithLimit(request, MAX_UPLOAD_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonError(413, `Upload at most ${MAX_UPLOAD_FILES} CVs (${MAX_CV_MB} MB each) at a time.`);
    }
    return jsonError(400, "Couldn't read the upload. Try again with fewer files.");
  }
  const files = form.getAll("files").filter((value): value is File => typeof value !== "string");
  if (files.length === 0) return jsonError(400, "Choose at least one CV to upload.");
  if (files.length > MAX_UPLOAD_FILES) return jsonError(400, `Upload at most ${MAX_UPLOAD_FILES} CVs at a time.`);

  const results: UploadResult[] = [];
  // Intentional: sequential, not Promise.all — keeps result order, bounds memory/disk I/O per request, and lets a
  // second identical file in the same request hit the duplicate check.
  for (const file of files) {
    const fallbackName = file.name || "cv";
    try {
      const cv = await validateCvUpload(file);
      const candidate = await createCandidateFromCv({ job, source: "upload", cv });
      results.push({ fileName: cv.fileName, ok: true, candidateId: candidate.id });
    } catch (err) {
      if (err instanceof DuplicateCvError) {
        results.push({ fileName: fallbackName, ok: false, code: "duplicate", error: "Already in this job." });
        continue;
      }
      if (!(err instanceof CvValidationError)) console.error("Employer CV upload failed", err);
      const error = err instanceof CvValidationError ? err.message : "Couldn't save this file.";
      results.push({ fileName: fallbackName, ok: false, error });
    }
  }

  const createdIds = results.flatMap((r) => (r.ok ? [r.candidateId] : []));
  if (createdIds.length > 0) {
    try {
      scheduleCandidateProcessing(createdIds);
    } catch (err) {
      // Intentional: the CVs are saved as "pending" and get re-queued on the next server boot; a 500
      // here would make the client retry and create duplicate candidates.
      console.error("Couldn't schedule uploaded CVs for processing", err);
    }
  }

  return Response.json({ results, created: createdIds.length } satisfies UploadResponse);
}
