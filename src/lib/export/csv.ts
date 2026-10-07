import "server-only";
import { neutralizeFormula, type ExportCell } from "./rows";

const BOM = "﻿";

function field(value: ExportCell | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV with CRLF line endings, prefixed with a BOM so Excel reads it as UTF-8. */
export function toCsv<C extends string>(columns: readonly C[], rows: readonly Record<C, ExportCell>[]): string {
  const lines = [columns.map(field), ...rows.map((row) => columns.map((c) => field(row[c])))];
  return BOM + lines.map((cells) => cells.join(",") + "\r\n").join("");
}
