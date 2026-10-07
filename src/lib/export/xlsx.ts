import "server-only";
import { Workbook, type Column } from "exceljs";
import { neutralizeFormula, type ExportCell, type ExportColumn } from "./rows";

const WIDE_COLUMNS = new Set<string>(["AI summary", "Strengths", "Concerns"] satisfies ExportColumn[]);
// Excel refuses to open a file with a longer cell.
const MAX_CELL_CHARS = 32767;
const FALLBACK_SHEET_NAME = "Candidates";

const dropTrailingHighSurrogate = (s: string) => s.replace(/[\uD800-\uDBFF]$/, "");

/** Excel sheet names: 1–31 chars, none of []:*?/\, no leading/trailing ', and not "History". */
export function sanitizeSheetName(name: string): string {
  const clean = name
    .replace(/[[\]:*?/\\\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .trim();
  const capped = dropTrailingHighSurrogate(clean.slice(0, 31)).replace(/'+$/, "").trim();
  return !capped || capped.toLowerCase() === "history" ? FALLBACK_SHEET_NAME : capped;
}

function cellValue(value: ExportCell | undefined): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Intentional: exceljs never evaluates plain strings, but the guard is kept as defence in depth
  // in case the sheet is re-saved as CSV or the value is copied into a formula-aware tool.
  return dropTrailingHighSurrogate(neutralizeFormula(value).slice(0, MAX_CELL_CHARS));
}

function columnWidth(column: string, values: (string | number | null)[]): number {
  if (WIDE_COLUMNS.has(column)) return 60;
  const longest = values.reduce<number>((max, v) => Math.max(max, v === null ? 0 : String(v).length), column.length);
  return Math.min(Math.max(longest + 2, 8), 40);
}

export async function toXlsx<C extends string>(
  columns: readonly C[],
  rows: readonly Record<C, ExportCell>[],
  opts: { sheetName: string },
): Promise<Buffer> {
  const values = rows.map((row) => columns.map((c) => cellValue(row[c])));

  const wb = new Workbook();
  wb.created = new Date();
  const sheet = wb.addWorksheet(sanitizeSheetName(opts.sheetName), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = columns.map(
    (column, i): Partial<Column> => ({
      header: column,
      width: columnWidth(
        column,
        values.map((r) => r[i]),
      ),
      style: { alignment: { vertical: "top", wrapText: WIDE_COLUMNS.has(column) } },
    }),
  );
  sheet.addRows(values);

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF3" } };
    cell.alignment = { vertical: "middle" };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: columns.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
