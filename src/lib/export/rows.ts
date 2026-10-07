import "server-only";
import type { Candidate } from "@/db/schema";
import { CANDIDATE_SOURCE_LABELS, CANDIDATE_STAGE_LABELS, CANDIDATE_STATUS_LABELS, RECOMMENDATION_LABELS } from "@/lib/format";

export const EXPORT_COLUMNS = [
  "Rank",
  "Name",
  "Email",
  "Phone",
  "Location",
  "Headline",
  "Total experience (years)",
  "Match score",
  "Recommendation",
  "Skills score",
  "Experience score",
  "Education score",
  "Matched skills",
  "Missing skills",
  "Strengths",
  "Concerns",
  "AI summary",
  "All skills",
  "Most recent role",
  "Education",
  "Certifications",
  "Languages",
  "Links",
  "Stage",
  "Source",
  "Analysis status",
  "Added on",
  "CV file",
  "Ranked by",
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];
export type ExportCell = string | number | null;
export type ExportRow = Record<ExportColumn, ExportCell>;

/**
 * CV content is attacker-controlled: a cell starting with one of these is run as a formula by
 * Excel/Sheets/LibreOffice (e.g. =HYPERLINK exfiltration), so it's prefixed with ' to force text.
 */
export function neutralizeFormula(value: string): string {
  // Intentional: digits-only values (phone numbers like "+234 803 555 0142", "-5") can't call functions,
  // so they pass through — prefixing them would put a stray apostrophe in every international phone number.
  if (/^[+-]?[\d\s()./-]*\d[\d\s()./-]*$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const text = (...values: (string | null | undefined)[]): string | null => {
  for (const v of values) if (v && v.trim()) return v;
  return null;
};

const num = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const list = (values: string[] | null | undefined, separator: string): string | null =>
  text((values ?? []).filter((v) => v && v.trim()).join(separator));

/** Ranked order in, one row per candidate out. Null-safe for candidates still pending or failed. */
export function toExportRows(candidates: Candidate[]): ExportRow[] {
  return candidates.map((c, i) => {
    const p = c.profile;
    const e = c.evaluation;
    const role = p?.experience?.[0];
    const edu = p?.education?.[0];
    const status = CANDIDATE_STATUS_LABELS[c.status];

    let education: string | null = null;
    if (edu) {
      const course = [edu.degree, edu.field].filter((v) => v?.trim()).join(", ");
      const main = [course, edu.institution].filter((v) => v?.trim()).join(" — ");
      education = text(edu.graduationYear ? (main ? `${main} (${edu.graduationYear})` : edu.graduationYear) : main);
    }

    return {
      Rank: i + 1,
      Name: text(c.name, p?.fullName, c.cvFileName),
      Email: text(c.email, p?.email),
      Phone: text(c.phone, p?.phone),
      Location: text(p?.location),
      Headline: text(p?.headline),
      "Total experience (years)": num(p?.totalExperienceYears),
      "Match score": num(c.score),
      Recommendation: e ? (RECOMMENDATION_LABELS[e.recommendation] ?? null) : null,
      "Skills score": num(e?.skillsScore),
      "Experience score": num(e?.experienceScore),
      "Education score": num(e?.educationScore),
      "Matched skills": list(e?.matchedSkills, "; "),
      "Missing skills": list(e?.missingSkills, "; "),
      Strengths: list(e?.strengths, " | "),
      Concerns: list(e?.concerns, " | "),
      "AI summary": text(e?.summary),
      "All skills": list(p?.skills, "; "),
      "Most recent role": role ? list([role.title, role.company], " at ") : null,
      Education: education,
      Certifications: list(p?.certifications, "; "),
      Languages: list(p?.languages, "; "),
      Links: list(p?.links, "; "),
      Stage: CANDIDATE_STAGE_LABELS[c.stage],
      Source: CANDIDATE_SOURCE_LABELS[c.source],
      "Analysis status": c.status === "failed" && c.error ? `${status}: ${c.error}` : status,
      "Added on": c.createdAt.toISOString().slice(0, 10),
      "CV file": c.cvFileName,
      "Ranked by": list([c.aiProvider ?? "", c.aiModel ?? ""], " / "),
    };
  });
}
