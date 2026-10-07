import { z } from "zod";
import { CANDIDATE_STAGES, type Job } from "@/db/schema";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { BodyTooLargeError, readFormDataWithLimit } from "@/lib/body-limit";
import { listCandidatesForJob } from "@/lib/data/candidates";
import { getJobForCompany } from "@/lib/data/jobs";
import { toCsv } from "@/lib/export/csv";
import { safeFileStem } from "@/lib/export/file-name";
import { EXPORT_COLUMNS, toExportRows } from "@/lib/export/rows";
import { toXlsx } from "@/lib/export/xlsx";
import { isSameOrigin, jsonError } from "@/lib/http";

// A GET selection travels in the URL, so it's kept short; larger selections are POSTed.
const MAX_GET_IDS = 300;
const MAX_POST_IDS = 1000;
const MAX_POST_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

/** One CV for the browser-built ZIP, in ranked order. */
export type ZipManifestEntry = {
  id: string;
  /** The same rank the CSV/XLSX rows carry; null while unscored. */
  rank: number | null;
  /** The export's Name column. */
  name: string;
  cvFileName: string;
  /** Stored file type (pdf, docx, doc or txt), from the server-generated storage key. */
  cvExt: string;
  cvSize: number;
};

/**
 * `format=manifest`: what a ZIP of this selection contains. The CSV, XLSX and every CV are then fetched and
 * zipped in the browser, because a server-built ZIP of many CVs can exceed Netlify's 20 MB response and 60 s caps.
 */
export type ZipManifest = { baseName: string; candidates: ZipManifestEntry[] };

const idsSchema = (max: number) =>
  z
    .array(z.uuid({ error: "Invalid candidate ids." }), { error: "Invalid candidate ids." })
    .min(1, { error: "Invalid candidate ids." })
    .max(max, { error: `You can export at most ${max} selected candidates.` });

const exportFields = {
  // Intentional: "zip" is accepted only to answer it with a clear 400 — the ZIP is now built in the browser, and a
  // tab loaded before that change still asks the server for it.
  format: z.enum(["csv", "xlsx", "manifest", "zip"], { error: "Invalid export format." }),
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
  if (format === "zip") return jsonError(400, "ZIP exports are built in the browser.");

  const candidates = await listCandidatesForJob(companyId, job.id, { ids, stage });
  if (candidates.length === 0) return jsonError(400, "No candidates to export.");

  const rows = toExportRows(candidates);
  const baseName = `${fileSlug(job.title)}-candidates-${new Date().toISOString().slice(0, 10)}`;

  if (format === "manifest") {
    const manifest: ZipManifest = {
      baseName,
      candidates: candidates.map((c, i) => ({
        id: c.id,
        rank: c.rank,
        name: String(rows[i].Name ?? c.cvFileName),
        cvFileName: c.cvFileName,
        cvExt: c.cvFileKey.slice(c.cvFileKey.lastIndexOf(".") + 1),
        cvSize: c.cvSize,
      })),
    };
    return Response.json(manifest, { headers: { "Cache-Control": "private, no-store" } });
  }

  const body =
    format === "csv"
      ? toCsv(EXPORT_COLUMNS, rows)
      : new Uint8Array(await toXlsx(EXPORT_COLUMNS, rows, { sheetName: job.title }));

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
  const job = await getJobForCompany(employer.companyId, jobId);
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
  const job = await getJobForCompany(employer.companyId, jobId);
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
