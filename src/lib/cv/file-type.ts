export const CV_FILE_TYPES = ["pdf", "docx", "txt"] as const;
export type CvFileType = (typeof CV_FILE_TYPES)[number];

export const MAX_CV_BYTES = 5 * 1024 * 1024;

export const CV_MIME_TYPES: Record<CvFileType, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

/** Value for <input type="file" accept>. */
export const CV_ACCEPT = ".pdf,.docx,.txt," + Object.values(CV_MIME_TYPES).join(",");

/**
 * Decides the type from the file's bytes, not its name or the client-sent MIME type
 * (both attacker-controlled). The extension only disambiguates zip-based formats and text.
 */
export function detectCvFileType(bytes: Uint8Array, fileName: string): CvFileType | null {
  const ext = fileName.toLowerCase().split(".").pop();
  const startsWith = (sig: number[]) => sig.every((b, i) => bytes[i] === b);

  if (startsWith([0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) && ext === "docx") return "docx"; // PK zip
  if (ext === "txt" && !bytes.subarray(0, 4096).includes(0)) return "txt";
  return null;
}
