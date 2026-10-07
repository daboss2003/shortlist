import type { CandidateSource, CandidateStage, CandidateStatus, EmploymentType, JobStatus } from "@/db/schema";
import type { Recommendation } from "@/lib/ai/schemas";

// Single source of human-readable labels — used by UI and exports alike.

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  internship: "Internship",
  temporary: "Temporary",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = { open: "Open", closed: "Closed" };

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  pending: "Queued",
  processing: "Analyzing",
  ready: "Ranked",
  failed: "Failed",
};

export const CANDIDATE_STAGE_LABELS: Record<CandidateStage, string> = {
  new: "New",
  shortlisted: "Shortlisted",
  rejected: "Rejected",
};

export const CANDIDATE_SOURCE_LABELS: Record<CandidateSource, string> = {
  public: "Applied via link",
  upload: "Uploaded by team",
};

export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  strong_fit: "Strong fit",
  good_fit: "Good fit",
  possible_fit: "Possible fit",
  not_a_fit: "Not a fit",
};

export type ScoreTone = "success" | "warning" | "danger";

export function scoreTone(score: number): ScoreTone {
  if (score >= 75) return "success";
  if (score >= 50) return "warning";
  return "danger";
}

const dateFmt = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });
export const formatDate = (d: Date) => dateFmt.format(d);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
