import { getCurrentEmployer } from "@/lib/auth/dal";
import { getCandidateForCompany } from "@/lib/data/candidates";
import { jsonError } from "@/lib/http";
import { readCvFile } from "@/lib/storage";

/** Downloads a candidate's original CV. Tenant-scoped: a foreign id is a 404. */
export async function GET(_request: Request, ctx: RouteContext<"/api/candidates/[candidateId]/cv">) {
  const employer = await getCurrentEmployer();
  if (!employer) return jsonError(401, "Your session has expired. Sign in again.");

  const { candidateId } = await ctx.params;
  const candidate = getCandidateForCompany(employer.companyId, candidateId);
  if (!candidate) return jsonError(404, "CV not found.");

  let bytes: Buffer;
  try {
    bytes = await readCvFile(candidate.cvFileKey);
  } catch {
    return jsonError(404, "The CV file is no longer available.");
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": candidate.cvMimeType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": contentDisposition(candidate.cvFileName),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

/** RFC 6266: an ASCII-only fallback plus the exact UTF-8 name (RFC 5987) for modern browsers. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
