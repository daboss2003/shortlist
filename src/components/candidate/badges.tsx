import { Clock, Link2, Loader2, Upload } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { CandidateSource, CandidateStage, CandidateStatus } from "@/db/schema";
import type { Recommendation } from "@/lib/ai/schemas";
import {
  CANDIDATE_SOURCE_LABELS,
  CANDIDATE_STAGE_LABELS,
  CANDIDATE_STATUS_LABELS,
  RECOMMENDATION_LABELS,
} from "@/lib/format";

const statusTones: Record<CandidateStatus, BadgeTone> = {
  pending: "neutral",
  processing: "brand",
  ready: "success",
  failed: "danger",
};

/** AI pipeline state. Failed shows the error on hover. */
export function StatusBadge({ status, error }: { status: CandidateStatus; error?: string | null }) {
  return (
    <Badge tone={statusTones[status]} title={status === "failed" && error ? error : undefined}>
      {status === "pending" && <Clock aria-hidden />}
      {status === "processing" && <Loader2 aria-hidden className="animate-spin" />}
      {CANDIDATE_STATUS_LABELS[status]}
    </Badge>
  );
}

const stageTones: Record<CandidateStage, BadgeTone> = {
  new: "neutral",
  shortlisted: "success",
  rejected: "danger",
};

export function StageBadge({ stage }: { stage: CandidateStage }) {
  return <Badge tone={stageTones[stage]}>{CANDIDATE_STAGE_LABELS[stage]}</Badge>;
}

const recommendationTones: Record<Recommendation, BadgeTone> = {
  strong_fit: "success",
  good_fit: "brand",
  possible_fit: "warning",
  not_a_fit: "danger",
};

/** AI fit verdict. Renders an em dash when there is no evaluation yet. */
export function RecommendationBadge({ recommendation }: { recommendation: Recommendation | null | undefined }) {
  if (!recommendation) return <span className="text-sm text-ink-faint">—</span>;
  return <Badge tone={recommendationTones[recommendation]}>{RECOMMENDATION_LABELS[recommendation]}</Badge>;
}

/** Where the CV came from. `compact` shows only the icon (label stays available to screen readers and on hover). */
export function SourceBadge({ source, compact = false }: { source: CandidateSource; compact?: boolean }) {
  const Icon = source === "public" ? Link2 : Upload;
  const label = CANDIDATE_SOURCE_LABELS[source];
  return (
    <Badge tone="neutral" title={compact ? label : undefined}>
      <Icon aria-hidden />
      {compact ? <span className="sr-only">{label}</span> : label}
    </Badge>
  );
}
