import { z } from "zod";
import { CANDIDATE_STAGES, type Job } from "@/db/schema";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { BodyTooLargeError, readFormDataWithLimit } from "@/lib/body-limit";
import { listCandidatesForJob } from "@/lib/data/candidates";
import { getJobForCompany } from "@/lib/data/jobs";
import { toCsv } from "@/lib/export/csv";
import { EXPORT_COLUMNS, toExportRows } from "@/lib/export/rows";
import { toXlsx } from "@/lib/export/xlsx";
import { ZipTooLargeError, buildCandidatesZip, safeFileStem } from "@/lib/export/zip";
import { isSameOrigin, jsonError } from "@/lib/http";

// A GET selection travels in the URL, so it's kept short; larger selections are POSTed.
const MAX_GET_IDS = 300;
const MAX_POST_IDS = 1000;
const MAX_POST_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
} as const;

const idsSchema = (max: number) =>
  z
    .array(z.uuid({ error: "Invalid candidate ids." }), { error: "Invalid candidate ids." })
    .min(1, { error: "Invalid candidate ids." })
    .max(max, { error: `You can export at most ${max} selected candidates.` });

const exportFields = {
  format: z.enum(["csv", "xlsx", "zip"], { error: "Invalid export format." }),
  stage: z.enum(CANDIDATE_STAGES, { error: "Invalid stage." }).optional(),
};
const getSchema = z.object({ ...exportFields, ids: idsSchema(MAX_GET_IDS).optional() });
const postSchema = z.object({ ...exportFields, ids: idsSchema(MAX_POST_IDS) });

type ExportQuery = z.infer<typeof getSchema>;

/** `ids` may be repeated and/or comma-separated. Absent → undefined. */
function splitIds(values: FormDataEntryValue[]): string[] | undefined {
  if (values.length === 0) return undefined;
  return values
    .map((v) => (typeof v === "string" ? v : ""))
    .join(",")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Empty or missing → undefined, so a blank form field means "not given". */
const optionalField = (value: FormDataEntryValue | null) => (value === null || value === "" ? undefined : value);

/** Lowercase ASCII slug for the download name, max 50 chars. */
const fileSlug = (title: string) => safeFileStem(title, "job").toLowerCase().slice(0, 50).replace(/-+$/, "") || "job";

async function exportCandidates(companyId: string, job: Job, { format, stage, ids }: ExportQuery): Promise<Response> {
  const candidates = listCandidatesForJob(companyId, job.id, { ids, stage });
  if (candidates.length === 0) return jsonError(400, "No candidates to export.");

  const rows = toExportRows(candidates);
  const baseName = `${fileSlug(job.title)}-candidates-${new Date().toISOString().slice(0, 10)}`;

  let body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
  if (format === "csv") body = toCsv(EXPORT_COLUMNS, rows);
  else if (format === "xlsx") body = new Uint8Array(await toXlsx(EXPORT_COLUMNS, rows, { sheetName: job.title }));
  else {
    try {
      body = await buildCandidatesZip(candidates, rows, { baseName, sheetName: job.title });
    } catch (err) {
      if (err instanceof ZipTooLargeError) return jsonError(400, err.message);
      throw err;
    }
  }

  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${baseName}.${format}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// GET has no side effects, so (unlike mutating handlers) it needs no isSameOrigin() check.
export async function GET(request: Request, ctx: RouteContext<"/api/jobs/[jobId]/export">) {
  const employer = await getCurrentEmployer();
  if (!employer) return jsonError(401, "Not signed in.");

  const { jobId } = await ctx.params;
  const job = getJobForCompany(employer.companyId, jobId);
  if (!job) return jsonError(404, "Job not found.");

  const params = new URL(request.url).searchParams;
  const query = getSchema.safeParse({
    format: optionalField(params.get("format")),
    stage: optionalField(params.get("stage")),
    ids: splitIds(params.getAll("ids")),
  });
  if (!query.success) return jsonError(400, query.error.issues[0]?.message ?? "Invalid export request.");
  return exportCandidates(employer.companyId, job, query.data);
}

/** Same export for selections too long for a URL: form fields `format`, `stage?`, `ids` (comma-separated). */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[jobId]/export">) {
  const employer = await getCurrentEmployer();
  if (!employer) return jsonError(401, "Not signed in.");
  // Nothing is mutated, but like every cookie-auth POST it's same-origin only, so no other site can trigger it.
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request blocked.");

  const { jobId } = await ctx.params;
  const job = getJobForCompany(employer.companyId, jobId);
  if (!job) return jsonError(404, "Job not found.");

  let form: FormData;
  try {
    form = await readFormDataWithLimit(request, MAX_POST_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(413, `You can export at most ${MAX_POST_IDS} selected candidates.`);
    return jsonError(400, "Invalid export request.");
  }

  const query = postSchema.safeParse({
    format: optionalField(form.get("format")),
    stage: optionalField(form.get("stage")),
    ids: splitIds(form.getAll("ids")),
  });
  if (!query.success) return jsonError(400, query.error.issues[0]?.message ?? "Invalid export request.");
  return exportCandidates(employer.companyId, job, query.data);
}
