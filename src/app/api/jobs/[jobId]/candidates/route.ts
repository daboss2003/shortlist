import { getCurrentEmployer } from "@/lib/auth/dal";
import { BodyTooLargeError, readFormDataWithLimit } from "@/lib/body-limit";
import { CvValidationError, DuplicateCvError, createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { MAX_CV_BYTES } from "@/lib/cv/file-type";
import { getJobForCompany } from "@/lib/data/jobs";
import { isSameOrigin, jsonError } from "@/lib/http";
import { scheduleCandidateProcessing } from "@/lib/pipeline";
import { describeError } from "@/lib/log";

// Intentional: one CV per request, with 256 KB on top for the multipart boundary and part headers. Netlify
// Functions accept ~4.5 MB of binary per request, so a batch is sent by the client as one request per file.
const MAX_UPLOAD_BODY_BYTES = MAX_CV_BYTES + 256 * 1024;
const MAX_CV_MB = MAX_CV_BYTES / (1024 * 1024);

export type UploadResult =
  | { fileName: string; ok: true; candidateId: string }
  | { fileName: string; ok: false; error: string; code?: "duplicate" };

/** `results` always holds exactly one entry: the result for the request's single file. */
export type UploadResponse = { results: UploadResult[]; created: number };

/** Employer upload of one CV they already hold. Closed jobs take no new CVs; identical files are skipped. */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[jobId]/candidates">) {
  const employer = await getCurrentEmployer();
  if (!employer) return jsonError(401, "Your session has expired. Sign in again.");
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request blocked.");

  const { jobId } = await ctx.params;
  const job = await getJobForCompany(employer.companyId, jobId);
  if (!job) return jsonError(404, "Job not found.");
  if (job.status === "closed") return jsonError(409, "This job is closed. Reopen it to add CVs.");

  let form: FormData;
  try {
    form = await readFormDataWithLimit(request, MAX_UPLOAD_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(413, `That CV is larger than ${MAX_CV_MB} MB.`);
    return jsonError(400, "Couldn't read the upload. Try again.");
  }
  const files = form.getAll("files").filter((value): value is File => typeof value !== "string");
  if (files.length === 0) return jsonError(400, "Choose a CV to upload.");
  if (files.length > 1) return jsonError(400, "Upload one CV per request.");

  const result = await storeUpload(job, files[0]);
  if (result.ok) {
    try {
      await scheduleCandidateProcessing([result.candidateId]);
    } catch (err) {
      // Intentional: the CV is already saved as "pending", which the pipeline's periodic re-queue picks up; a 500
      // here would stop the client's batch and report a stored CV as not uploaded.
      console.error("Couldn't schedule an uploaded CV for processing:", describeError(err));
    }
  }

  return Response.json({ results: [result], created: result.ok ? 1 : 0 } satisfies UploadResponse);
}

async function storeUpload(job: { id: string; companyId: string }, file: File): Promise<UploadResult> {
  const fallbackName = file.name || "cv";
  try {
    const cv = await validateCvUpload(file);
    const candidate = await createCandidateFromCv({ job, source: "upload", cv });
    return { fileName: cv.fileName, ok: true, candidateId: candidate.id };
  } catch (err) {
    if (err instanceof DuplicateCvError) {
      return { fileName: fallbackName, ok: false, code: "duplicate", error: "Already in this job." };
    }
    if (!(err instanceof CvValidationError)) console.error("Employer CV upload failed:", describeError(err, { withStack: true }));
    const error = err instanceof CvValidationError ? err.message : "Couldn't save this file.";
    return { fileName: fallbackName, ok: false, error };
  }
}
