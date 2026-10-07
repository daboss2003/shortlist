"use client";

import { useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { Check, Download, Loader2, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import type { CandidateStage, CandidateStatus } from "@/db/schema";
import { deleteCandidateAction, rescoreAction, updateStageAction, type ReviewActionResult } from "../../actions";

type Action = CandidateStage | "rescore" | "delete";

/** Runs one review action at a time and surfaces failures inline. */
function useReviewAction() {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(action: Action, call: () => Promise<ReviewActionResult>) {
    setError(null);
    setBusy(action);
    startTransition(async () => {
      try {
        const result = await call();
        if (!result.ok) setError(result.error);
      } catch (err) {
        // Re-throws Next's redirect after a successful delete.
        unstable_rethrow(err);
        setError("Something went wrong. Try again.");
      }
    });
  }

  return { pending, active: pending ? busy : null, error, run };
}

const STAGE_BUTTONS: Array<{ stage: CandidateStage; label: string; Icon: typeof Check }> = [
  { stage: "shortlisted", label: "Shortlist", Icon: Check },
  { stage: "rejected", label: "Reject", Icon: X },
  { stage: "new", label: "Move to New", Icon: Undo2 },
];

export function CandidateActions({
  jobId,
  candidateId,
  stage,
  status,
}: {
  jobId: string;
  candidateId: string;
  stage: CandidateStage;
  status: CandidateStatus;
}) {
  const { pending, active, error, run } = useReviewAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const analyzing = status === "pending" || status === "processing";

  const icon = (action: Action, Icon: typeof Check) =>
    active === action ? <Loader2 className="animate-spin" aria-hidden /> : <Icon aria-hidden />;

  return (
    <div className="flex flex-col gap-3 lg:items-end">
      <div className="flex flex-wrap gap-2 lg:justify-end">
        {STAGE_BUTTONS.filter((b) => b.stage !== stage).map(({ stage: target, label, Icon }) => (
          <Button
            key={target}
            variant={target === "shortlisted" ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => run(target, () => updateStageAction(jobId, [candidateId], target))}
          >
            {icon(target, Icon)}
            {label}
          </Button>
        ))}
        <Button
          variant="secondary"
          disabled={pending || analyzing}
          title={analyzing ? "This CV is being analyzed right now." : undefined}
          onClick={() => run("rescore", () => rescoreAction(jobId, [candidateId]))}
        >
          {icon("rescore", RefreshCw)}
          Re-score
        </Button>
        <a href={`/api/candidates/${candidateId}/cv`} download className={buttonClass("secondary")}>
          <Download aria-hidden />
          Download CV
        </a>
        {!confirmDelete && (
          <Button variant="danger" disabled={pending} onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden />
            Delete
          </Button>
        )}
      </div>

      {confirmDelete && (
        <div
          role="group"
          aria-label="Confirm deletion"
          className="flex flex-col gap-3 rounded-lg border border-danger/20 bg-danger-soft px-4 py-3 sm:flex-row sm:items-center"
        >
          <p className="text-sm text-danger">Delete this candidate and their CV? This can&apos;t be undone.</p>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => run("delete", () => deleteCandidateAction(jobId, candidateId))}
            >
              {icon("delete", Trash2)}
              Delete candidate
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmDelete(false)} autoFocus>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** "Try again" for a failed analysis. */
export function RetryAnalysisButton({ jobId, candidateId }: { jobId: string; candidateId: string }) {
  const { pending, error, run } = useReviewAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => run("rescore", () => rescoreAction(jobId, [candidateId]))}
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        Try again
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
