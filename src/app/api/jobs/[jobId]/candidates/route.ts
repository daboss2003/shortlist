import { getCurrentEmployer } from "@/lib/auth/dal";
import { CvValidationError, createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { getJobForCompany } from "@/lib/data/jobs";
import { isSameOrigin, jsonError } from "@/lib/http";
import { scheduleCandidateProcessing } from "@/lib/pipeline";

const MAX_UPLOAD_FILES = 50;

export type UploadResult =
  | { fileName: string; ok: true; candidateId: string }
  | { fileName: string; ok: false; error: string };

export type UploadResponse = { results: UploadResult[]; created: number };

/** Employer bulk upload of CVs they already hold. Uploads to closed jobs are allowed (employer's call). */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[jobId]/candidates">) {
  const employer = await getCurrentEmployer();
  if (!employer) return jsonError(401, "Your session has expired. Sign in again.");
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request blocked.");

  const { jobId } = await ctx.params;
  const job = getJobForCompany(employer.companyId, jobId);
  if (!job) return jsonError(404, "Job not found.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "Couldn't read the upload. Try again with fewer files.");
  }
  const files = form.getAll("files").filter((value): value is File => typeof value !== "string");
  if (files.length === 0) return jsonError(400, "Choose at least one CV to upload.");
  if (files.length > MAX_UPLOAD_FILES) return jsonError(400, `Upload at most ${MAX_UPLOAD_FILES} CVs at a time.`);

  const results: UploadResult[] = [];
  // Intentional: sequential, not Promise.all — keeps result order and bounds memory/disk I/O per request.
  for (const file of files) {
    const fallbackName = file.name || "cv";
    try {
      const cv = await validateCvUpload(file);
      const candidate = await createCandidateFromCv({ job, source: "upload", cv });
      results.push({ fileName: cv.fileName, ok: true, candidateId: candidate.id });
    } catch (err) {
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
