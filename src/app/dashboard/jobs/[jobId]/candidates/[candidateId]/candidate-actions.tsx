"use client";

import { useId, useRef, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { Check, Download, Loader2, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import type { CandidateStage, CandidateStatus } from "@/db/schema";
import { CANDIDATE_STAGE_LABELS } from "@/lib/format";
import { useAnnounce } from "../../_components/announcer";
import { downloadFile } from "../../_components/download";
import { useRestoreFocus } from "../../_components/use-restore-focus";
import { deleteCandidateAction, rescoreAction, updateStageAction, type ReviewActionResult } from "../../actions";

type Action = CandidateStage | "rescore" | "delete";

/** Runs one review action at a time and surfaces failures inline. */
function useReviewAction() {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(action: Action, call: () => Promise<ReviewActionResult>, onSuccess?: () => void) {
    setError(null);
    setBusy(action);
    startTransition(async () => {
      try {
        const result = await call();
        if (!result.ok) setError(result.error);
        else onSuccess?.();
      } catch (err) {
        // Re-throws Next's redirect after a successful delete.
        unstable_rethrow(err);
        setError("Something went wrong. Try again.");
      }
    });
  }

  return { pending, active: pending ? busy : null, error, setError, run };
}

const STAGE_BUTTONS: Array<{ stage: CandidateStage; label: string; Icon: typeof Check }> = [
  { stage: "shortlisted", label: "Shortlist", Icon: Check },
  { stage: "rejected", label: "Reject", Icon: X },
  { stage: "new", label: "Move to New", Icon: Undo2 },
];

export function CandidateActions({
  jobId,
  candidateId,
  cvFileName,
  stage,
  status,
}: {
  jobId: string;
  candidateId: string;
  cvFileName: string;
  stage: CandidateStage;
  status: CandidateStatus;
}) {
  const announce = useAnnounce();
  const { pending, active, error, setError, run } = useReviewAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const deleteTriggerId = useId();
  const restoreFocus = useRestoreFocus(!pending);
  const analyzing = status === "pending" || status === "processing";

  const icon = (action: Action, Icon: typeof Check) =>
    active === action ? <Loader2 className="animate-spin" aria-hidden /> : <Icon aria-hidden />;

  async function downloadCv() {
    setError(null);
    setDownloading(true);
    const outcome = await downloadFile(`/api/candidates/${candidateId}/cv`, undefined, cvFileName);
    setDownloading(false);
    if (outcome.ok) announce("CV downloaded");
    else setError(outcome.sessionExpired ? outcome.error : `Couldn't download the CV — ${outcome.error}`);
  }

  return (
    <div className="flex flex-col gap-3 lg:items-end">
      <div ref={buttonsRef} className="flex flex-wrap gap-2 lg:justify-end">
        {STAGE_BUTTONS.filter((b) => b.stage !== stage).map(({ stage: target, label, Icon }) => (
          <Button
            key={target}
            variant={target === "shortlisted" ? "primary" : "secondary"}
            disabled={pending}
            onClick={() =>
              run(
                target,
                () => updateStageAction(jobId, [candidateId], target),
                () => {
                  announce(`Moved to ${CANDIDATE_STAGE_LABELS[target]}`);
                  // The clicked button disappears once the stage changes.
                  restoreFocus(() => buttonsRef.current?.querySelector("button"));
                },
              )
            }
          >
            {icon(target, Icon)}
            {label}
          </Button>
        ))}
        <Button
          variant="secondary"
          disabled={pending || analyzing}
          title={analyzing ? "This CV is being analyzed right now." : undefined}
          onClick={() =>
            run(
              "rescore",
              () => rescoreAction(jobId, [candidateId]),
              () => announce("Re-scoring this candidate"),
            )
          }
        >
          {icon("rescore", RefreshCw)}
          Re-score
        </Button>
        <Button variant="secondary" disabled={downloading} onClick={downloadCv}>
          {downloading ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
          Download CV
        </Button>
        {!confirmDelete && (
          <Button id={deleteTriggerId} variant="danger" disabled={pending} onClick={() => setConfirmDelete(true)}>
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
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setConfirmDelete(false);
                restoreFocus(deleteTriggerId);
              }}
              autoFocus
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <Alert tone="danger" className="lg:max-w-md">
          {error}
        </Alert>
      )}
    </div>
  );
}

/** "Try again" for a failed analysis. */
export function RetryAnalysisButton({ jobId, candidateId }: { jobId: string; candidateId: string }) {
  const announce = useAnnounce();
  const { pending, error, run } = useReviewAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          run(
            "rescore",
            () => rescoreAction(jobId, [candidateId]),
            () => announce("Re-scoring this candidate"),
          )
        }
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
