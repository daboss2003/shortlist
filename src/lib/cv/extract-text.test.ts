import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractCvText } from "./extract-text";

async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/** A minimal valid PDF: one page per entry, each drawing its text in Helvetica. Xref offsets are computed. */
function buildPdf(pages: string[]): Buffer {
  const fontId = 3 + pages.length * 2;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  pages.forEach((text, i) => {
    const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("extractCvText", () => {
  it("decodes plain text as UTF-8", async () => {
    const text = await extractCvText(Buffer.from("﻿José Müller\nSenior Engineer\n", "utf8"), "txt");
    expect(text).toBe("José Müller\nSenior Engineer");
  });

  it("extracts paragraphs from a .docx", async () => {
    const text = await extractCvText(await buildDocx(["Jane Doe", "Senior Backend Engineer"]), "docx");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("Senior Backend Engineer");
  });

  it("extracts text from a PDF, merging all pages", async () => {
    const text = await extractCvText(buildPdf(["Jane Doe", "Senior Backend Engineer"]), "pdf");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("Senior Backend Engineer");
    expect(text.indexOf("Jane Doe")).toBeLessThan(text.indexOf("Senior Backend Engineer"));
  });

  it("rejects bytes that aren't a real PDF", async () => {
    await expect(extractCvText(Buffer.from("%PDF-1.4\nnot really a pdf"), "pdf")).rejects.toThrow();
  });

  it("normalizes control characters, line endings, trailing spaces and blank lines", async () => {
    const raw = "  \n Jane\u0000 Doe\u0007   \r\nSkills:\tNode.js\u001b\u007f  \r\n\r\n\r\n\r\n\r\n\r\nPage\u000ctwo\rEnd  \n\n";
    expect(await extractCvText(Buffer.from(raw, "utf8"), "txt")).toBe(
      "Jane Doe\nSkills:\tNode.js\n\n\nPage\ntwo\nEnd",
    );
  });
});
