import "server-only";
import { Readable } from "node:stream";
import JSZip from "jszip";
import type { RankedCandidate } from "@/lib/data/candidates";
import { readCvFile } from "@/lib/storage";
import { toCsv } from "./csv";
import { EXPORT_COLUMNS, type ExportRow } from "./rows";
import { toXlsx } from "./xlsx";

// JSZip writes ZIP32 only (no ZIP64), so an archive past 4 GiB or 65,535 entries would be corrupt. These caps
// stay well clear of that and bound the up-front existence check below.
const MAX_ZIP_CVS = 5000;
const MAX_ZIP_CV_BYTES = 1024 ** 3;

/** The export is too big for one ZIP. Message is user-safe. */
export class ZipTooLargeError extends Error {
  constructor() {
    super("Too many CVs for one ZIP — export a stage or a selection.");
  }
}

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

const rankLabel = (rank: number | null) => (rank === null ? "Unranked" : `#${rank}`);

/** `cvs/007-Jane-Doe.pdf` by on-screen rank; `cvs/unranked-1a2b3c4d-Jane-Doe.pdf` for unscored candidates. */
function cvEntryName(candidate: RankedCandidate, name: string, used: Set<string>): string {
  const ext = candidate.cvFileKey.split(".").pop();
  const stem = safeFileStem(name);
  const prefix = candidate.rank === null ? `unranked-${candidate.id.slice(0, 8)}` : String(candidate.rank).padStart(3, "0");
  let entry = `cvs/${prefix}-${stem}.${ext}`;
  // Two unranked ids can share their first 8 characters; the full id keeps the name unique.
  if (used.has(entry)) entry = `cvs/${prefix}-${candidate.id}-${stem}.${ext}`;
  used.add(entry);
  return entry;
}

async function cvFileExists(key: string): Promise<boolean> {
  try {
    // Intentional: storage exposes no stat or stream API, so existence is checked by reading the file and
    // discarding it — one file in memory at a time. The archive then reads each CV again, lazily.
    await readCvFile(key);
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") console.error(`CV export: can't read ${key}`, err);
    return false;
  }
}

/** A stream that reads the CV only when JSZip reaches its entry, so at most a few CVs are in memory. */
function lazyCvStream(key: string): Readable {
  return Readable.from(
    (async function* () {
      try {
        yield await readCvFile(key);
      } catch (err) {
        // Intentional: the file vanished after the existence check. The headers are already sent, so the
        // download fails (the client sees a network error) rather than shipping a silently empty CV.
        console.error(`CV export: ${key} disappeared mid-download`, err);
        throw err;
      }
    })(),
    { objectMode: false },
  );
}

/**
 * Streams a ZIP of the CSV, the XLSX and every original CV. `rows` must be `toExportRows(candidates)` (same
 * order). CVs missing from disk are skipped and listed in missing-files.txt rather than failing the export.
 * Throws ZipTooLargeError before anything is read when the export is over the size caps.
 */
export async function buildCandidatesZip(
  candidates: RankedCandidate[],
  rows: ExportRow[],
  opts: { baseName: string; sheetName?: string },
): Promise<ReadableStream<Uint8Array>> {
  const totalBytes = candidates.reduce((sum, c) => sum + c.cvSize, 0);
  if (candidates.length > MAX_ZIP_CVS || totalBytes > MAX_ZIP_CV_BYTES) throw new ZipTooLargeError();

  const zip = new JSZip();
  zip.file(`${opts.baseName}.csv`, toCsv(EXPORT_COLUMNS, rows), { compression: "DEFLATE" });
  zip.file(`${opts.baseName}.xlsx`, await toXlsx(EXPORT_COLUMNS, rows, { sheetName: opts.sheetName ?? "Candidates" }));

  const missing: string[] = [];
  const used = new Set<string>();
  // Intentional: sequential checks — a large job could otherwise open hundreds of file handles at once.
  for (const [i, candidate] of candidates.entries()) {
    const name = String(rows[i]?.Name ?? candidate.cvFileName);
    if (!(await cvFileExists(candidate.cvFileKey))) {
      missing.push(`${rankLabel(candidate.rank)} — ${name} (${candidate.cvFileName})`);
      continue;
    }
    const ext = candidate.cvFileKey.split(".").pop();
    // PDFs and DOCX are already compressed; plain text is worth deflating.
    zip.file(cvEntryName(candidate, name, used), lazyCvStream(candidate.cvFileKey), {
      compression: ext === "txt" ? "DEFLATE" : "STORE",
    });
  }

  if (missing.length > 0) {
    zip.file(
      "missing-files.txt",
      `These candidates' CV files could not be found, so they are not in this download:\r\n\r\n${missing.join("\r\n")}\r\n`,
    );
  }

  const archive = zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "STORE" });
  // Intentional: JSZip's Node stream is a readable-stream v2 Readable, typed as NodeJS.ReadableStream; Readable.toWeb
  // accepts it at runtime. JSZip's deferred resume() can run a few CVs ahead of a slow client, but no further.
  return Readable.toWeb(archive as Readable) as ReadableStream<Uint8Array>;
}
