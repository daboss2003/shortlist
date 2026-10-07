import { z } from "zod";
import { CANDIDATE_STAGES } from "@/db/schema";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { listCandidatesForJob } from "@/lib/data/candidates";
import { getJobForCompany } from "@/lib/data/jobs";
import { toCsv } from "@/lib/export/csv";
import { EXPORT_COLUMNS, toExportRows } from "@/lib/export/rows";
import { toXlsx } from "@/lib/export/xlsx";
import { buildCandidatesZip, safeFileStem } from "@/lib/export/zip";
import { jsonError } from "@/lib/http";

const MAX_IDS = 1000;

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
} as const;

const querySchema = z.object({
  format: z.enum(["csv", "xlsx", "zip"], { error: "Invalid export format." }),
  stage: z.enum(CANDIDATE_STAGES, { error: "Invalid stage." }).optional(),
  ids: z
    .array(z.uuid({ error: "Invalid candidate ids." }))
    .min(1, { error: "Invalid candidate ids." })
    .max(MAX_IDS, { error: `You can export at most ${MAX_IDS} selected candidates.` })
    .optional(),
});

function parseQuery(url: URL) {
  const ids = url.searchParams.getAll("ids");
  return querySchema.safeParse({
    format: url.searchParams.get("format") ?? undefined,
    stage: url.searchParams.get("stage") ?? undefined,
    ids:
      ids.length > 0
        ? ids
            .join(",")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
        : undefined,
  });
}

/** Lowercase ASCII slug for the download name, max 50 chars. */
const fileSlug = (title: string) => safeFileStem(title, "job").toLowerCase().slice(0, 50).replace(/-+$/, "") || "job";

// GET has no side effects, so (unlike mutating handlers) it needs no isSameOrigin() check.
export async function GET(request: Request, ctx: RouteContext<"/api/jobs/[jobId]/export">) {
  const employer = await getCurrentEmployer();
  if (!employer) return jsonError(401, "Not signed in.");

  const { jobId } = await ctx.params;
  const job = getJobForCompany(employer.companyId, jobId);
  if (!job) return jsonError(404, "Job not found.");

  const query = parseQuery(new URL(request.url));
  if (!query.success) return jsonError(400, query.error.issues[0]?.message ?? "Invalid export request.");
  const { format, stage, ids } = query.data;

  const candidates = listCandidatesForJob(employer.companyId, job.id, { ids, stage });
  if (candidates.length === 0) return jsonError(400, "No candidates to export.");

  const rows = toExportRows(candidates);
  const baseName = `${fileSlug(job.title)}-candidates-${new Date().toISOString().slice(0, 10)}`;

  let body: string | Uint8Array<ArrayBuffer>;
  if (format === "csv") body = toCsv(EXPORT_COLUMNS, rows);
  else if (format === "xlsx") body = new Uint8Array(await toXlsx(EXPORT_COLUMNS, rows, { sheetName: job.title }));
  else body = new Uint8Array(await buildCandidatesZip(candidates, rows, { baseName, sheetName: job.title }));

  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${baseName}.${format}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
