import { Workbook } from "exceljs";
import { describe, expect, it } from "vitest";
import { sanitizeSheetName, toXlsx } from "./xlsx";

const columns = ["Name", "Match score", "AI summary"] as const;

async function load(buffer: Buffer) {
  const wb = new Workbook();
  // Intentional: exceljs's typings declare their own ArrayBuffer-based `Buffer`; a Node Buffer works at runtime.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe("toXlsx", () => {
  it("writes a styled, frozen, filterable header and typed cells", async () => {
    const buffer = await toXlsx(
      columns,
      [
        { Name: "José", "Match score": 88, "AI summary": "Strong fit." },
        { Name: "=HYPERLINK(\"http://evil.example\")", "Match score": null, "AI summary": null },
      ],
      { sheetName: "Backend Engineer" },
    );
    expect(Buffer.isBuffer(buffer)).toBe(true);

    const sheet = (await load(buffer)).worksheets[0];
    expect(sheet.name).toBe("Backend Engineer");
    expect(sheet.getRow(1).values).toEqual([undefined, "Name", "Match score", "AI summary"]);
    expect(sheet.getCell("A1").font?.bold).toBe(true);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();

    expect(sheet.getCell("A2").value).toBe("José");
    expect(sheet.getCell("B2").value).toBe(88);
    expect(typeof sheet.getCell("B2").value).toBe("number");
    expect(sheet.getCell("B3").value).toBeNull();
    expect(sheet.getCell("A3").value).toBe("'=HYPERLINK(\"http://evil.example\")");

    expect(sheet.getColumn(3).width).toBeGreaterThanOrEqual(50);
    expect(sheet.getCell("C2").alignment?.wrapText).toBe(true);
  });

  it("sanitizes the sheet name for Excel", async () => {
    const buffer = await toXlsx(columns, [], { sheetName: "[Senior] Dev/Ops: *Lead*? \\ Platform & Infra Team" });
    const name = (await load(buffer)).worksheets[0].name;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
    expect(name).toBe(sanitizeSheetName("[Senior] Dev/Ops: *Lead*? \\ Platform & Infra Team"));
  });
});

describe("sanitizeSheetName", () => {
  it("strips forbidden characters, caps length and falls back when empty", () => {
    expect(sanitizeSheetName("Front/Back [end]")).toBe("Front Back end");
    expect(sanitizeSheetName("x".repeat(40))).toHaveLength(31);
    expect(sanitizeSheetName("  ///  ")).toBe("Candidates");
    expect(sanitizeSheetName("'quoted'")).toBe("quoted");
    expect(sanitizeSheetName("history")).toBe("Candidates");
  });
});
