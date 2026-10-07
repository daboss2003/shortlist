"use client";

import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SubmitButton } from "./submit-button";

export function DeleteJobCard({
  jobTitle,
  candidateCount,
  deleteAction,
}: {
  jobTitle: string;
  candidateCount: number;
  deleteAction: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const startRef = useRef<HTMLButtonElement>(null);
  const candidates = candidateCount === 1 ? "1 candidate" : `${candidateCount} candidates`;

  return (
    <Card className="border-danger/30">
      <CardHeader title="Danger zone" description="Deleting a job can't be undone." />
      <CardBody className="py-5">
        {confirming ? (
          <form action={deleteAction} className="space-y-4" aria-labelledby="delete-job-confirm">
            <p id="delete-job-confirm" className="text-sm text-ink">
              Delete <span className="font-semibold">{jobTitle}</span>
              {candidateCount > 0 ? (
                <>
                  {" "}and its <span className="font-semibold">{candidates}</span>, including their CV files?
                </>
              ) : (
                "?"
              )}{" "}
              The application link will stop working immediately.
            </p>
            <div className="flex flex-col-reverse gap-3 sm:flex-row">
              <Button
                variant="secondary"
                autoFocus
                onClick={() => {
                  setConfirming(false);
                  requestAnimationFrame(() => startRef.current?.focus());
                }}
              >
                Cancel
              </Button>
              <SubmitButton variant="danger" pendingLabel="Deleting…">
                <Trash2 aria-hidden />
                Yes, delete job
              </SubmitButton>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink-muted">
              {candidateCount > 0
                ? `Removes the job, its application link and all ${candidates}, including their CV files.`
                : "Removes the job and its application link."}
            </p>
            <Button ref={startRef} variant="danger" className="shrink-0" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden />
              Delete job
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
