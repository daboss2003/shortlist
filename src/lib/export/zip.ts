import "server-only";
import JSZip from "jszip";
import type { Candidate } from "@/db/schema";
import { readCvFile } from "@/lib/storage";
import { toCsv } from "./csv";
import { EXPORT_COLUMNS, type ExportRow } from "./rows";
import { toXlsx } from "./xlsx";

/** ASCII letters, digits and single dashes, max 60 chars. Accents are folded (José → Jose). */
export function safeFileStem(name: string, fallback = "candidate"): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return stem || fallback;
}

/**
 * `rows` must be `toExportRows(candidates)` (same order). Missing CV files are skipped and listed in
 * missing-files.txt rather than failing the whole export.
 */
export async function buildCandidatesZip(
  candidates: Candidate[],
  rows: ExportRow[],
  opts: { baseName: string; sheetName?: string },
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(`${opts.baseName}.csv`, toCsv(EXPORT_COLUMNS, rows));
  zip.file(`${opts.baseName}.xlsx`, await toXlsx(EXPORT_COLUMNS, rows, { sheetName: opts.sheetName ?? "Candidates" }), {
    compression: "STORE",
  });

  const missing: string[] = [];
  // Intentional: sequential reads — a large job could otherwise open hundreds of file handles at once.
  for (const [i, candidate] of candidates.entries()) {
    const rank = i + 1;
    const name = String(rows[i]?.Name ?? candidate.cvFileName);
    let bytes: Buffer;
    try {
      bytes = await readCvFile(candidate.cvFileKey);
    } catch (err) {
      // Intentional: one unreadable CV must not fail the export; it's reported in missing-files.txt.
      if ((err as { code?: string })?.code !== "ENOENT") console.error(`CV export: can't read ${candidate.cvFileKey}`, err);
      missing.push(`${rank}. ${name} (${candidate.cvFileName})`);
      continue;
    }
    const ext = candidate.cvFileKey.split(".").pop();
    const file = `cvs/${String(rank).padStart(3, "0")}-${safeFileStem(name)}.${ext}`;
    // PDFs and DOCX are already compressed.
    zip.file(file, bytes, { compression: ext === "txt" ? "DEFLATE" : "STORE" });
  }

  if (missing.length > 0) {
    zip.file(
      "missing-files.txt",
      `These candidates' CV files could not be found, so they are not in this download:\r\n\r\n${missing.join("\r\n")}\r\n`,
    );
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
