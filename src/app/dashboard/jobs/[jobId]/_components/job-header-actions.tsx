"use client";

import { useId, useState, useTransition } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { Loader2, Lock, LockOpen, Pencil, Upload } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import type { JobStatus } from "@/db/schema";
import { formatDate } from "@/lib/format";
import { setJobStatus } from "../../actions";
import { useAnnounce } from "./announcer";
import { useRestoreFocus } from "./use-restore-focus";

export const UPLOAD_SECTION_ID = "upload-cvs";
export const UPLOAD_DROPZONE_ID = "upload-cvs-dropzone";
export const UPLOAD_MORE_ID = "upload-cvs-more";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Brings the upload card into view and focuses the control it currently shows. */
export function UploadCvsButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  function reveal() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(UPLOAD_SECTION_ID)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    // The drop zone is swapped for the file list while a batch uploads and for "Upload more CVs" once it's done.
    const target =
      document.getElementById(UPLOAD_DROPZONE_ID) ??
      document.getElementById(UPLOAD_MORE_ID) ??
      document.getElementById(UPLOAD_SECTION_ID);
    target?.focus({ preventScroll: true });
  }

  return (
    <Button variant={variant} onClick={reveal}>
      <Upload aria-hidden />
      Upload CVs
    </Button>
  );
}

/** Edit, open/close (closing asks first) and upload. Upload is hidden while the job is closed. */
export function JobHeaderActions({
  jobId,
  status,
  retentionDays,
}: {
  jobId: string;
  status: JobStatus;
  /** Company's candidate-data retention period; null = off. */
  retentionDays: number | null;
}) {
  const router = useRouter();
  const announce = useAnnounce();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Open while the close confirmation shows; carries the deletion date it quotes (null when retention is off).
  const [confirmClose, setConfirmClose] = useState<{ deletionDate: string | null } | null>(null);
  const toggleId = useId();
  const confirmTextId = useId();
  // The confirmation's buttons unmount on success/cancel; focus goes back to the (re-enabled) toggle.
  const restoreFocus = useRestoreFocus(!pending);

  function changeStatus(next: JobStatus) {
    setError(null);
    startTransition(async () => {
      try {
        await setJobStatus(jobId, next);
        router.refresh();
        setConfirmClose(null);
        restoreFocus(toggleId);
        announce(
          next === "closed"
            ? "Job closed. The application link no longer accepts CVs."
            : "Job reopened. The application link accepts CVs again.",
        );
      } catch (err) {
        unstable_rethrow(err);
        setError(next === "closed" ? "Couldn't close the job. Try again." : "Couldn't reopen the job. Try again.");
      }
    });
  }

  function onToggle() {
    if (status === "closed") {
      changeStatus("open");
      return;
    }
    setError(null);
    setConfirmClose({
      // The retention clock starts when the job closes, i.e. now.
      deletionDate: retentionDays === null ? null : formatDate(new Date(Date.now() + retentionDays * DAY_MS)),
    });
  }

  function cancelClose() {
    setConfirmClose(null);
    restoreFocus(toggleId);
  }

  return (
    <div className="flex shrink-0 flex-col gap-3 lg:items-end">
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        <ButtonLink href={`/dashboard/jobs/${jobId}/edit`} variant="secondary">
          <Pencil aria-hidden />
          Edit job
        </ButtonLink>
        <Button
          id={toggleId}
          variant="secondary"
          onClick={onToggle}
          disabled={pending}
          aria-expanded={status === "open" ? confirmClose !== null : undefined}
        >
          {pending && !confirmClose ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : status === "open" ? (
            <Lock aria-hidden />
          ) : (
            <LockOpen aria-hidden />
          )}
          {status === "open" ? "Close job" : "Reopen job"}
        </Button>
        {status === "open" && <UploadCvsButton />}
      </div>

      {confirmClose && status === "open" && (
        <div
          role="group"
          aria-labelledby={confirmTextId}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-xs lg:max-w-md"
        >
          <p id={confirmTextId} className="text-sm text-ink">
            Close this job? The application link will stop accepting CVs
            {confirmClose.deletionDate && (
              <>
                , and candidate data will be deleted on{" "}
                <span className="font-medium whitespace-nowrap">{confirmClose.deletionDate}</span>
              </>
            )}
            .
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => changeStatus("closed")} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Lock aria-hidden />}
              Close job
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelClose} disabled={pending} autoFocus>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger lg:max-w-md lg:text-right">
          {error}
        </p>
      )}
    </div>
  );
}
