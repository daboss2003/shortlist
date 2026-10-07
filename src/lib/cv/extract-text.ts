import "server-only";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import type { CvFileType } from "@/lib/cv/file-type";

/** Plain text of a CV file, normalized for the AI prompt. Throws if the file can't be parsed. */
export async function extractCvText(bytes: Buffer, fileType: CvFileType): Promise<string> {
  return normalizeText(await rawText(bytes, fileType));
}

async function rawText(bytes: Buffer, fileType: CvFileType): Promise<string> {
  switch (fileType) {
    case "pdf": {
      // A copy: PDF.js rejects Node Buffers and may detach the array it's given.
      const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
      return text;
    }
    case "docx":
      return (await mammoth.extractRawText({ buffer: bytes })).value;
    case "txt":
      return new TextDecoder("utf-8").decode(bytes);
  }
}

function normalizeText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // Form feeds / vertical tabs separate pages or lines in some extractors; keep them as breaks.
      .replace(/[\f\v]/g, "\n")
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(/[^\S\n]+$/gm, "")
      // At most 2 consecutive blank lines.
      .replace(/\n{4,}/g, "\n\n\n")
      .trim()
  );
}
