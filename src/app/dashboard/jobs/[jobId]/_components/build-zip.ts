import type { ZipManifestEntry } from "@/app/api/jobs/[jobId]/export/route";
import { safeFileStem } from "@/lib/export/file-name";

// Assembles the "ZIP of CVs" export in the browser from files already fetched (see zip-export.ts). Pure apart
// from loading JSZip, so it runs under Vitest as-is.

// JSZip writes ZIP32 only (no ZIP64), so an archive past 4 GiB or 65,535 entries would be corrupt. These caps stay
// well clear of that and are checked against the manifest before any CV is fetched.
export const MAX_ZIP_CVS = 5000;
export const MAX_ZIP_CV_BYTES = 1024 ** 3;
export const ZIP_TOO_LARGE_MESSAGE = "Too many CVs for one ZIP — export a stage or a selection.";

/**
 * Query parameter on the export POST that asks for a ZIP's CSV/XLSX, pinned to the manifest's ids: the export
 * route then accepts up to MAX_ZIP_CVS ids instead of a selection's 1000.
 */
export const ZIP_SPREADSHEET_QUERY = { name: "for", value: "zip" } as const;

export function zipTooLarge(entries: Pick<ZipManifestEntry, "cvSize">[]): boolean {
  const totalBytes = entries.reduce((sum, e) => sum + e.cvSize, 0);
  return entries.length > MAX_ZIP_CVS || totalBytes > MAX_ZIP_CV_BYTES;
}

/** A manifest entry and its CV, or null when the CV couldn't be fetched. */
export type FetchedCv = { entry: ZipManifestEntry; file: Blob | null };

export type ZipContents = {
  /** `{job}-candidates-{date}`: names the spreadsheets inside and the ZIP itself. */
  baseName: string;
  csv: Blob;
  xlsx: Blob;
  /** In manifest (ranked) order. */
  cvs: FetchedCv[];
};

const rankLabel = (rank: number | null) => (rank === null ? "Unranked" : `#${rank}`);

/**
 * `cvs/007-Jane-Doe.pdf` by on-screen rank; `cvs/unranked-1a2b3c4d-Jane-Doe.pdf` for unscored candidates.
 * `used` collects the names handed out so far, so every entry stays unique.
 */
export function cvEntryName(entry: ZipManifestEntry, used: Set<string>): string {
  const stem = safeFileStem(entry.name);
  const prefix = entry.rank === null ? `unranked-${entry.id.slice(0, 8)}` : String(entry.rank).padStart(3, "0");
  let name = `cvs/${prefix}-${stem}.${entry.cvExt}`;
  // Two unranked ids can share their first 8 characters; the full id keeps the name unique.
  if (used.has(name)) name = `cvs/${prefix}-${entry.id}-${stem}.${entry.cvExt}`;
  used.add(name);
  return name;
}

/** Body of missing-files.txt (CRLF, for Notepad), or null when every CV is present. */
export function missingFilesText(missing: ZipManifestEntry[]): string | null {
  if (missing.length === 0) return null;
  const lines = missing.map((e) => `${rankLabel(e.rank)} — ${e.name} (${e.cvFileName})`);
  return `These candidates' CV files could not be found or downloaded, so they are not in this ZIP:\r\n\r\n${lines.join("\r\n")}\r\n`;
}

/** The ZIP's own download name. */
export const zipFileName = (baseName: string) => `${baseName}.zip`;

/**
 * Builds the ZIP: the CSV, the XLSX, every CV that was fetched (named by rank) and, when some couldn't be,
 * missing-files.txt listing them. JSZip is loaded here, on first use, so it never weighs on the page itself.
 */
export async function buildCandidatesZip({ baseName, csv, xlsx, cvs }: ZipContents): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(`${baseName}.csv`, await bytes(csv), { binary: true, compression: "DEFLATE" });
  zip.file(`${baseName}.xlsx`, await bytes(xlsx), { binary: true });

  const used = new Set<string>();
  const missing: ZipManifestEntry[] = [];
  for (const { entry, file } of cvs) {
    if (!file) {
      missing.push(entry);
      continue;
    }
    // PDFs and DOCX are already compressed; plain text is worth deflating.
    zip.file(cvEntryName(entry, used), await bytes(file), {
      binary: true,
      compression: entry.cvExt === "txt" ? "DEFLATE" : "STORE",
    });
  }

  const missingText = missingFilesText(missing);
  if (missingText) zip.file("missing-files.txt", missingText);

  return zip.generateAsync({ type: "blob", mimeType: "application/zip", compression: "STORE" });
}

// Intentional: Blob → bytes before handing to JSZip. JSZip reads Blobs with FileReader, which Node (and so the
// tests) doesn't have; Blob.arrayBuffer() works in both, and JSZip holds every entry in memory either way.
const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
