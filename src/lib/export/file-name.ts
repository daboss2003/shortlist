// Shared by the export route (download names) and the browser-side ZIP builder (CV entry names), so no
// "server-only" here.

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
