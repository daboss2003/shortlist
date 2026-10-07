"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "../../_components/submit-button";

/** Revoke with a confirm step, inline in the invites table row. */
export function RevokeInviteButton({ invitee, revokeAction }: { invitee: string; revokeAction: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const startRef = useRef<HTMLButtonElement>(null);

  if (!confirming) {
    return (
      <Button ref={startRef} variant="danger" size="sm" onClick={() => setConfirming(true)} aria-label={`Revoke invite: ${invitee}`}>
        Revoke
      </Button>
    );
  }

  return (
    <form action={revokeAction} className="flex items-center justify-end gap-2" aria-label={`Confirm revoking invite: ${invitee}`}>
      <Button
        variant="ghost"
        size="sm"
        autoFocus
        onClick={() => {
          setConfirming(false);
          requestAnimationFrame(() => startRef.current?.focus());
        }}
      >
        Cancel
      </Button>
      <SubmitButton variant="danger" size="sm" pendingLabel="Revoking…">
        Yes, revoke
      </SubmitButton>
    </form>
  );
}
