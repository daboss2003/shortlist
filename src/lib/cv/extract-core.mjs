// The CV text extraction itself, shared by both extraction modes (src/lib/cv/extract-text.ts):
// - isolated: scripts/extract-cv-text.mjs runs this in a short-lived, memory-capped child process;
// - inline: serverless functions import it directly (each invocation is already its own sandbox).
// Plain ESM on purpose: the isolated child runs it directly under node, outside the Next/TS toolchain.

const MAX_OUTPUT_CHARS = 200_000;
// Normalizing shrinks text, so keep more raw input than we output, but never an unbounded amount.
const MAX_RAW_CHARS = 1_000_000;
const MAX_DOCX_ENTRY_BYTES = 15 * 1024 * 1024;
const MAX_DOCX_TOTAL_BYTES = 40 * 1024 * 1024;
const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Normalized plain text of a CV, at most 200,000 characters. Throws if the file can't be parsed.
 * @param {Buffer} bytes
 * @param {string} fileType "pdf" | "docx" | "doc" | "txt"
 * @returns {Promise<string>}
 */
export async function extractText(bytes, fileType) {
  const raw = await rawText(bytes, fileType);
  return sliceSafe(normalizeText(sliceSafe(raw, MAX_RAW_CHARS)), MAX_OUTPUT_CHARS);
}

/**
 * Linear time on any input: no regex here can backtrack over a long run of the same character.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    // Form feeds / vertical tabs separate pages or lines in some extractors; keep them as breaks.
    .replace(/[\f\v]/g, "\n")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "");

  const lines = [];
  let blankRun = 0;
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed === "") {
      // At most 2 consecutive blank lines.
      if (++blankRun > 2) continue;
    } else {
      blankRun = 0;
    }
    lines.push(trimmed);
  }
  return lines.join("\n").trim();
}

/**
 * Slice without splitting a UTF-16 surrogate pair.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function sliceSafe(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

class RejectedFileError extends Error {}

/**
 * @param {Buffer} bytes
 * @param {string} fileType
 * @returns {Promise<string>}
 */
async function rawText(bytes, fileType) {
  switch (fileType) {
    case "pdf": {
      const { extractText: extractPdfText } = await import("unpdf");
      // A copy: PDF.js rejects Node Buffers and may detach the array it's given.
      const { text } = await extractPdfText(new Uint8Array(bytes), { mergePages: true });
      return text;
    }
    case "docx":
      return docxText(bytes);
    case "doc": {
      // Intentional: word-extractor also accepts zip files, which would get past the DOCX size guard; a .doc
      // must be an OLE2 compound file.
      if (!OLE2_SIGNATURE.equals(bytes.subarray(0, OLE2_SIGNATURE.length))) {
        throw new RejectedFileError("not a Word 97-2003 document");
      }
      const { default: WordExtractor } = await import("word-extractor");
      const doc = await new WordExtractor().extract(bytes);
      return joinAroundBody(
        [doc.getHeaders({ includeFooters: false })],
        doc.getBody(),
        [doc.getTextboxes({ includeHeadersAndFooters: false, includeBody: true }), doc.getFootnotes(), doc.getFooters()],
      );
    }
    case "txt":
      return new TextDecoder("utf-8").decode(bytes);
    default:
      throw new RejectedFileError(`unsupported file type: ${String(fileType).slice(0, 20)}`);
  }
}

/**
 * mammoth reads the body, tables and links, but skips page headers and footers (where many CV templates put the
 * name, email and phone) and text boxes outside a VML fallback (often a skills sidebar). Those are read here:
 * headers first, then the body, text boxes and footers. Lines already in the output aren't repeated.
 */
async function docxText(bytes) {
  const zip = await loadSizeCheckedDocx(bytes);
  const { default: mammoth } = await import("mammoth");
  const body = (await mammoth.extractRawText({ buffer: bytes })).value;

  try {
    const documentXml = zip.file("word/document.xml");
    const textBoxes = documentXml ? wordXmlText(await documentXml.async("string"), { textBoxesOnly: true }) : "";
    return joinAroundBody(
      [await docxPartsText(zip, /^word\/header\d*\.xml$/)],
      body,
      [textBoxes, await docxPartsText(zip, /^word\/footer\d*\.xml$/)],
    );
  } catch (err) {
    // Intentional: the body is what matters; a broken header or footer part mustn't make the whole CV unreadable.
    console.error(`skipped DOCX headers, footers and text boxes: ${err instanceof Error ? err.message : err}`);
    return body;
  }
}

async function docxPartsText(zip, namePattern) {
  const names = Object.keys(zip.files)
    .filter((name) => namePattern.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const parts = await Promise.all(names.map((name) => zip.file(name).async("string")));
  return parts.map((xml) => wordXmlText(xml)).join("\n");
}

/**
 * The body with extra sections (headers, text boxes, footers…) before and after it, separated by blank lines.
 * A line of an extra section that's already in the body or an earlier section is dropped: headers repeat
 * across sections, and some text boxes are also part of the body.
 */
function joinAroundBody(before, body, after) {
  const seen = new Set(body.split("\n").map((line) => line.trim()));
  const unseenLines = (text) => {
    const kept = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      kept.push(line);
    }
    return kept.join("\n");
  };
  const head = before.map(unseenLines);
  const tail = after.map(unseenLines);
  return [...head, body, ...tail].filter(Boolean).join("\n\n");
}

const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXmlEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([\dA-Fa-f]{1,6}));/g, (match, named, dec, hex) => {
    if (named) return XML_ENTITIES[named];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/**
 * Text of a WordprocessingML part: <w:t> content, <w:tab/> as a tab, <w:br/>, <w:cr/> and paragraph ends as
 * newlines. One linear scan, no regex over the document. With `textBoxesOnly`, only text inside <w:txbxContent>.
 * Of an mc:AlternateContent only the mc:Choice branch is read: Word repeats a text box in the VML mc:Fallback.
 * @param {string} xml
 * @param {{ textBoxesOnly?: boolean }} [options]
 * @returns {string}
 */
export function wordXmlText(xml, { textBoxesOnly = false } = {}) {
  const out = [];
  let inText = false;
  let textBoxDepth = 0;
  let fallbackDepth = 0;
  let tabStopsDepth = 0;
  const nest = (depth, closing) => (closing ? Math.max(0, depth - 1) : depth + 1);
  const emit = (text) => {
    if (fallbackDepth === 0 && (!textBoxesOnly || textBoxDepth > 0)) out.push(text);
  };

  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    if (inText && lt > i) emit(decodeXmlEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const gt = tagEnd(xml, lt + 1);
    if (gt === -1) break;
    const closing = xml[lt + 1] === "/";
    const selfClosing = xml[gt - 1] === "/";
    switch (tagName(xml, closing ? lt + 2 : lt + 1, gt)) {
      case "w:t":
        inText = !closing && !selfClosing;
        break;
      case "w:tab":
        // <w:tabs><w:tab …/></w:tabs> in paragraph properties are tab-stop definitions, not tabs.
        if (!closing && tabStopsDepth === 0) emit("\t");
        break;
      case "w:br":
      case "w:cr":
        if (!closing) emit("\n");
        break;
      case "w:p":
        if (closing || selfClosing) emit("\n");
        break;
      case "w:tabs":
        if (!selfClosing) tabStopsDepth = nest(tabStopsDepth, closing);
        break;
      case "w:txbxContent":
        if (!selfClosing) textBoxDepth = nest(textBoxDepth, closing);
        break;
      case "mc:Fallback":
        if (!selfClosing) fallbackDepth = nest(fallbackDepth, closing);
        break;
    }
    i = gt + 1;
  }
  return out.join("");
}

/** Index of the ">" ending the tag that starts before `from`, skipping quoted attribute values. */
function tagEnd(xml, from) {
  let quote = "";
  for (let j = from; j < xml.length; j++) {
    const c = xml[j];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    }
  }
  return -1;
}

function tagName(xml, start, end) {
  let j = start;
  while (j < end && xml[j] !== " " && xml[j] !== "/" && xml[j] !== "\t" && xml[j] !== "\n" && xml[j] !== "\r") j++;
  return xml.slice(start, j);
}

/**
 * Zip-bomb guard: reads only the zip's directory (nothing is decompressed) and checks the declared sizes.
 * Returns the loaded zip so its parts can be read without parsing the file again.
 */
async function loadSizeCheckedDocx(bytes) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    // Intentional: JSZip's private `_data` (a CompressedObject for a loaded zip) is the only place the
    // central directory's uncompressed size is exposed without decompressing the entry.
    const size = entry._data?.uncompressedSize;
    if (typeof size !== "number" || size < 0) throw new RejectedFileError("DOCX entry size unknown");
    if (size > MAX_DOCX_ENTRY_BYTES) throw new RejectedFileError("DOCX content too large");
    total += size;
    if (total > MAX_DOCX_TOTAL_BYTES) throw new RejectedFileError("DOCX content too large");
  }
  return zip;
}
