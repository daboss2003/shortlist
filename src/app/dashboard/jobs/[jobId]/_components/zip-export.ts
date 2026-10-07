import type { ZipManifest, ZipManifestEntry } from "@/app/api/jobs/[jobId]/export/route";
import { ZIP_TOO_LARGE_MESSAGE, buildCandidatesZip, zipFileName, zipTooLarge, type FetchedCv } from "./build-zip";
import { fetchFile, type DownloadFailure, type FetchFileOutcome } from "./download";

// Browser-side "ZIP of CVs": a server-built ZIP of many CVs can exceed Netlify's 20 MB response and 60 s limits,
// so the browser fetches the manifest, the CSV, the XLSX and each CV separately and zips them itself.

const CV_CONCURRENCY = 3;

/** The export request for a format, for the same selection (GET for a whole view, POST for selected ids). */
export type ExportRequest = (format: "manifest" | "csv" | "xlsx") => [url: string, init?: RequestInit];

export type ZipExportResult =
  | { ok: true; blob: Blob; fileName: string; total: number; missing: number }
  | DownloadFailure;

/**
 * Fetches everything and builds the ZIP. `onProgress` is called once the manifest is in (0 of N), then after each
 * CV. CVs that can't be fetched are listed in missing-files.txt instead of failing the export; an expired session
 * stops it.
 */
export async function prepareCvZip(
  request: ExportRequest,
  onProgress: (done: number, total: number) => void,
): Promise<ZipExportResult> {
  const manifest = await fetchManifest(...request("manifest"));
  if (!manifest.ok) return manifest;
  const { baseName, candidates } = manifest.data;
  if (zipTooLarge(candidates)) return { ok: false, sessionExpired: false, error: ZIP_TOO_LARGE_MESSAGE, status: 400 };
  onProgress(0, candidates.length);

  const [csv, xlsx] = await Promise.all([fetchFile(...request("csv")), fetchFile(...request("xlsx"))]);
  if (!csv.ok) return csv;
  if (!xlsx.ok) return xlsx;

  const cvs = await fetchCvs(candidates, onProgress);
  if (!Array.isArray(cvs)) return cvs;

  const blob = await buildCandidatesZip({ baseName, csv: csv.blob, xlsx: xlsx.blob, cvs });
  return {
    ok: true,
    blob,
    fileName: zipFileName(baseName),
    total: cvs.length,
    missing: cvs.filter((c) => !c.file).length,
  };
}

const UNEXPECTED: DownloadFailure = {
  ok: false,
  sessionExpired: false,
  error: "The server sent an unexpected response. Try again.",
  status: 200,
};

async function fetchManifest(url: string, init?: RequestInit): Promise<{ ok: true; data: ZipManifest } | DownloadFailure> {
  const res = await fetchFile(url, init);
  if (!res.ok) return res;
  try {
    const data = JSON.parse(await res.blob.text()) as Partial<ZipManifest> | null;
    if (typeof data?.baseName !== "string" || !Array.isArray(data.candidates)) return UNEXPECTED;
    return { ok: true, data: { baseName: data.baseName, candidates: data.candidates } };
  } catch {
    return UNEXPECTED;
  }
}

/** CVs in manifest order, `file: null` for any that couldn't be fetched; a failure only if the session expired. */
async function fetchCvs(
  entries: ZipManifestEntry[],
  onProgress: (done: number, total: number) => void,
): Promise<FetchedCv[] | DownloadFailure> {
  const results: FetchedCv[] = new Array<FetchedCv>(entries.length);
  // An object, not a `let`, so TypeScript doesn't narrow it to its initial value across the awaits below.
  const run = { next: 0, done: 0, stopped: null as DownloadFailure | null };

  async function worker() {
    while (!run.stopped && run.next < entries.length) {
      const index = run.next++;
      const entry = entries[index];
      const outcome = await fetchCv(entry.id);
      if (!outcome.ok && outcome.sessionExpired) {
        run.stopped ??= outcome;
        return;
      }
      results[index] = { entry, file: outcome.ok ? outcome.blob : null };
      onProgress(++run.done, entries.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CV_CONCURRENCY, entries.length) }, worker));
  return run.stopped ?? results;
}

async function fetchCv(candidateId: string): Promise<FetchFileOutcome> {
  const url = `/api/candidates/${encodeURIComponent(candidateId)}/cv`;
  const first = await fetchFile(url);
  // Intentional: one retry for a dropped connection or a server error, so a blip doesn't leave a CV out of the ZIP.
  // A 404 (file or candidate gone) is final.
  if (!first.ok && !first.sessionExpired && (first.status === 0 || first.status >= 500)) return fetchFile(url);
  return first;
}
