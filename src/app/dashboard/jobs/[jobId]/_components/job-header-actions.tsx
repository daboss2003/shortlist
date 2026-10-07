"use client";

import { useState, useTransition } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { Loader2, Lock, LockOpen, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JobStatus } from "@/db/schema";
import { setJobStatus } from "../../actions";

export const UPLOAD_SECTION_ID = "upload-cvs";
export const UPLOAD_DROPZONE_ID = "upload-cvs-dropzone";

/** Brings the upload card into view and focuses its drop zone. */
export function UploadCvsButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  function reveal() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(UPLOAD_SECTION_ID)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    document.getElementById(UPLOAD_DROPZONE_ID)?.focus({ preventScroll: true });
  }

  return (
    <Button variant={variant} onClick={reveal}>
      <Upload aria-hidden />
      Upload CVs
    </Button>
  );
}

/** Open/close the job's public application link. */
export function JobStatusToggle({ jobId, status }: { jobId: string; status: JobStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const next: JobStatus = status === "open" ? "closed" : "open";

  function toggle() {
    setError(null);
    startTransition(async () => {
      try {
        await setJobStatus(jobId, next);
        router.refresh();
      } catch (err) {
        unstable_rethrow(err);
        setError(next === "closed" ? "Couldn't close the job. Try again." : "Couldn't reopen the job. Try again.");
      }
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={toggle} disabled={pending}>
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : status === "open" ? (
          <Lock aria-hidden />
        ) : (
          <LockOpen aria-hidden />
        )}
        {status === "open" ? "Close job" : "Reopen job"}
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-danger sm:order-last sm:text-right">
          {error}
        </p>
      )}
    </>
  );
}
