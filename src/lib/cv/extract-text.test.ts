import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { normalizeText, wordXmlText } from "../../../scripts/extract-cv-text.mjs";
import { extractCvText, runCvExtractor } from "./extract-text";

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

const WORD_NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'mc:Ignorable=""',
].join(" ");
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/**
 * A CV laid out like common Word templates: contact details in the page header, a skills sidebar in a text box,
 * a two-column table, a hyperlink and a footer. `wordStyle` adds what Word itself writes: the text box repeated
 * in a VML fallback, and the header repeated for the first page.
 */
async function buildTemplateDocx({ wordStyle }: { wordStyle: boolean }): Promise<Buffer> {
  const zip = new JSZip();
  const headers = wordStyle ? ["header1.xml", "header2.xml"] : ["header1.xml"];
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${headers.map((h) => `<Override PartName="/word/${h}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`).join("")}<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${headers.map((h, i) => `<Relationship Id="rIdH${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${h}"/>`).join("")}<Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://github.com/chiomaobi" TargetMode="External"/></Relationships>`,
  );
  for (const h of headers) {
    zip.file(
      `word/${h}`,
      `<?xml version="1.0"?><w:hdr ${WORD_NS}>${para("HEADER-NAME Chioma Obi")}${para("HEADER-CONTACT chioma.obi@example.com · +234 802 555 0177")}</w:hdr>`,
    );
  }
  zip.file("word/footer1.xml", `<?xml version="1.0"?><w:ftr ${WORD_NS}>${para("FOOTER-REFERENCES available on request")}</w:ftr>`);

  const textBoxContent = `<w:txbxContent>${para("TEXTBOX-SKILLS Node.js, TypeScript, PostgreSQL")}</w:txbxContent>`;
  const fallback = wordStyle
    ? `<mc:Fallback><w:pict><v:shape><v:textbox>${textBoxContent}</v:textbox></v:shape></w:pict></mc:Fallback>`
    : "";
  const textBox = `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx>${textBoxContent}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>${fallback}</mc:AlternateContent></w:r></w:p>`;
  const cell = (...texts: string[]) => `<w:tc>${texts.map(para).join("")}</w:tc>`;
  const table = `<w:tbl><w:tr>${cell("TABLE-LEFT Experience", "Backend Engineer at Moniepoint 2021–present")}${cell("TABLE-RIGHT Education", "BSc Computer Engineering, OAU 2019")}</w:tr></w:tbl>`;
  const link = `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>HYPERLINK-TEXT github.com/chiomaobi</w:t></w:r></w:hyperlink></w:p>`;
  const sectPr = `<w:sectPr>${headers.map((_, i) => `<w:headerReference w:type="${i === 0 ? "default" : "first"}" r:id="rIdH${i}"/>`).join("")}<w:footerReference w:type="default" r:id="rIdF"/></w:sectPr>`;
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document ${WORD_NS}><w:body>${para("BODY-SUMMARY Backend engineer with 5 years building payment systems.")}${table}${textBox}${link}${sectPr}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const occurrences = (text: string, marker: string) => text.split(marker).length - 1;

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

  it("extracts a .docx's page header, footer and text boxes as well as its body, tables and links", async () => {
    const text = await extractCvText(await buildTemplateDocx({ wordStyle: false }), "docx");

    for (const marker of [
      "HEADER-NAME",
      "HEADER-CONTACT",
      "FOOTER-REFERENCES",
      "TEXTBOX-SKILLS",
      "BODY-SUMMARY",
      "TABLE-LEFT",
      "TABLE-RIGHT",
      "HYPERLINK-TEXT",
    ]) {
      expect(occurrences(text, marker), marker).toBe(1);
    }
    expect(text).toContain("chioma.obi@example.com · +234 802 555 0177");
    expect(text.indexOf("HEADER-NAME")).toBeLessThan(text.indexOf("BODY-SUMMARY"));
    expect(text.indexOf("FOOTER-REFERENCES")).toBeGreaterThan(text.indexOf("HYPERLINK-TEXT"));
  });

  it("doesn't repeat a header used by several sections, or a text box Word also wrote as a VML fallback", async () => {
    const text = await extractCvText(await buildTemplateDocx({ wordStyle: true }), "docx");
    expect(occurrences(text, "HEADER-NAME")).toBe(1);
    expect(occurrences(text, "HEADER-CONTACT")).toBe(1);
    expect(occurrences(text, "TEXTBOX-SKILLS")).toBe(1);
    expect(text.indexOf("HEADER-NAME")).toBeLessThan(text.indexOf("BODY-SUMMARY"));
  });

  it("extracts a legacy Word .doc", async () => {
    const text = await extractCvText(fs.readFileSync(path.join(process.cwd(), "test/fixtures/sample-cv.doc")), "doc");
    expect(text).toContain("Emeka Nwosu");
    expect(text).toContain("emeka.nwosu@example.com");
    expect(text.startsWith("Emeka Nwosu\nSenior Data Engineer")).toBe(true);
  });

  it("rejects a .doc that isn't a valid Word file, without hanging", async () => {
    // Seeded, so the test is deterministic.
    let seed = 42;
    const random = Uint8Array.from({ length: 20_000 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
    const ole2Header = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const started = performance.now();
    await expect(extractCvText(Buffer.from(random), "doc")).rejects.toThrow(/not a Word 97-2003 document/);
    await expect(extractCvText(Buffer.concat([ole2Header, random]), "doc")).rejects.toThrow();
    // A zip would be parsed as a .docx by the .doc library, skipping the zip-bomb guard.
    await expect(extractCvText(await buildTemplateDocx({ wordStyle: false }), "doc")).rejects.toThrow(
      /not a Word 97-2003 document/,
    );
    expect(performance.now() - started).toBeLessThan(5000);
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

  it("caps the extracted text at 200,000 characters", async () => {
    const text = await extractCvText(Buffer.from("word ".repeat(100_000), "utf8"), "txt");
    expect(text).toHaveLength(200_000);
  });

  it("rejects a DOCX zip bomb from its declared sizes, quickly and outside this process", async () => {
    const para = "<w:p><w:r><w:t>Lorem ipsum dolor sit amet</w:t></w:r></w:p>";
    const bomb = await zipOf({ "word/document.xml": para.repeat(Math.ceil((21 * 1024 * 1024) / para.length)) });
    expect(bomb.length).toBeLessThan(1024 * 1024);

    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    await expect(extractCvText(bomb, "docx")).rejects.toThrow(/DOCX content too large/);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(100 * 1024 * 1024);
  });

  it("rejects a DOCX whose entries are each under the limit but too large in total", async () => {
    const big = "a".repeat(14 * 1024 * 1024);
    const docx = await zipOf({ "word/document.xml": big, "word/a.xml": big, "word/b.xml": big });
    await expect(extractCvText(docx, "docx")).rejects.toThrow(/DOCX content too large/);
  });

  it(
    "kills the parser once its memory passes the cap, even when the zip lies about its sizes",
    async () => {
      const bomb = await lyingZipBomb(768);
      await expect(extractCvText(bomb, "docx")).rejects.toThrow(/memory limit exceeded/);
    },
    20_000,
  );
});

describe("normalizeText", () => {
  it("runs in linear time on long whitespace runs", () => {
    for (const input of [" ".repeat(40_000) + "x", "\t  ".repeat(40_000) + "x", "\n".repeat(200_000) + "x"]) {
      const started = performance.now();
      expect(normalizeText(input)).toBe("x");
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it("strips trailing whitespace on every line but keeps indentation", () => {
    expect(normalizeText("a  \n  b\t\n \n\n\n\nc")).toBe("a\n  b\n\n\nc");
  });
});

describe("wordXmlText", () => {
  it("reads runs, tabs, breaks and entities, but not tab-stop definitions", () => {
    const xml =
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>R&amp;D &lt;lead&gt; &quot;x&quot; &apos;y&apos; &#233;&#x1F600;</w:t><w:tab/><w:t>2021</w:t><w:br/><w:t xml:space="preserve">next</w:t></w:r></w:p><w:p/><w:p><w:r><w:delText>deleted</w:delText><w:instrText>HYPERLINK "x"</w:instrText></w:r></w:p>';
    expect(wordXmlText(xml)).toBe("R&D <lead> \"x\" 'y' é😀\t2021\nnext\n\n\n");
  });

  it("reads only the mc:Choice branch of alternate content, and only text boxes when asked", () => {
    const box = "<w:txbxContent><w:p><w:r><w:t>Skills</w:t></w:r></w:p></w:txbxContent>";
    const xml = `<w:p><w:r><w:t>Body</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">${box}</mc:Choice><mc:Fallback><w:pict><v:textbox>${box}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    expect(wordXmlText(xml)).toBe("Body\nSkills\n\n");
    expect(wordXmlText(xml, { textBoxesOnly: true })).toBe("Skills\n");
  });

  it("is linear on hostile markup", () => {
    for (const xml of ["<".repeat(200_000), '<w:t a="'.repeat(50_000), "<w:t>" + "&amp".repeat(100_000), "<!--".repeat(100_000)]) {
      const started = performance.now();
      wordXmlText(xml);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

describe("runCvExtractor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvp-extractor-stub-"));
  const stub = (name: string, source: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("kills a parser that runs past the timeout", async () => {
    const scriptPath = stub("sleep.mjs", "setTimeout(() => {}, 60_000);");
    const started = performance.now();
    await expect(runCvExtractor(Buffer.from("x"), "txt", { scriptPath, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("kills a parser that writes more than 1 MB", async () => {
    const scriptPath = stub("flood.mjs", 'process.stdout.write("x".repeat(2 * 1024 * 1024));');
    await expect(runCvExtractor(Buffer.from("x"), "txt", { scriptPath, timeoutMs: 10_000 })).rejects.toThrow(
      /too much output/,
    );
  });

  it("rejects with the parser's reason when it exits non-zero", async () => {
    const scriptPath = stub("fail.mjs", 'process.stderr.write("noise\\nbad file\\n"); process.exitCode = 3;');
    await expect(runCvExtractor(Buffer.from("x"), "pdf", { scriptPath, timeoutMs: 10_000 })).rejects.toThrow(
      /exit code 3.*bad file/,
    );
  });

  it("passes the bytes on stdin and the file type as an argument", async () => {
    const scriptPath = stub(
      "echo.mjs",
      "let s = ''; process.stdin.on('data', (c) => (s += c)).on('end', () => process.stdout.write(process.argv[2] + ':' + s));",
    );
    await expect(runCvExtractor(Buffer.from("héllo"), "docx", { scriptPath, timeoutMs: 10_000 })).resolves.toBe(
      "docx:héllo",
    );
  });

  it("doesn't pass secrets from the environment to the parser", async () => {
    vi.stubEnv("GEMINI_API_KEY", "secret-key");
    vi.stubEnv("NODE_OPTIONS", "--require=/nonexistent.js");
    const scriptPath = stub("env.mjs", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));");
    const keys: string[] = JSON.parse(await runCvExtractor(Buffer.from("x"), "txt", { scriptPath, timeoutMs: 10_000 }));
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts.
    expect(keys.filter((k) => !k.startsWith("__CF_"))).toEqual(["NODE_ENV", "PATH"]);
  });
});

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 1 } });
}

/**
 * A one-entry zip holding `mib` MiB of "a" that declares its uncompressed size as 1 KB, so a size check
 * that trusts the zip's headers lets it through. Compressed incrementally so this process stays small.
 */
async function lyingZipBomb(mib: number): Promise<Buffer> {
  const deflate = zlib.createDeflateRaw({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on("data", (c: Buffer) => chunks.push(c));
  const block = Buffer.alloc(1024 * 1024, 0x61);
  for (let i = 0; i < mib; i++) {
    if (!deflate.write(block)) await new Promise((r) => deflate.once("drain", r));
  }
  await new Promise<void>((r) => deflate.end(r));
  const data = Buffer.concat(chunks);
  const name = Buffer.from("word/document.xml");
  const declaredSize = 1000;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // DEFLATE
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);

  return Buffer.concat([local, name, data, central, name, end]);
}
