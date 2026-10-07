"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Check, Copy, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/field";
import { fieldA11y } from "../../_components/field-a11y";
import { LocalTime } from "../../_components/local-time";
import { SubmitButton } from "../../_components/submit-button";
import { useFreshResult } from "../../_components/use-fresh-result";
import { createInviteAction, type CreateInviteState } from "./actions";
import { DEFAULT_INVITE_DAY_CHOICE, INVITE_DAY_CHOICES } from "./invite-options";

const initialState: CreateInviteState = {};

export function CreateInviteForm() {
  const [state, formAction] = useActionState(createInviteAction, initialState);
  const fresh = useFreshResult(state);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  const days = values.days ?? DEFAULT_INVITE_DAY_CHOICE;
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.fieldErrors) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state]);

  return (
    <Card>
      <CardHeader
        title="Invite a company"
        description="Creates a one-time signup link. Whoever uses it sets up a new company account."
      />
      <CardBody className="space-y-5 py-5">
        {fresh && state.created && <CreatedInvite invite={state.created} />}
        <form ref={formRef} action={formAction} noValidate className="grid gap-5 sm:grid-cols-[1fr_12rem_auto] sm:items-start">
          <Field
            id="inviteEmail"
            label="Email"
            optional
            hint="If set, only this email can use the link."
            error={errors.email}
          >
            <Input
              id="inviteEmail"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={200}
              placeholder="hiring@company.com"
              defaultValue={values.email}
              {...fieldA11y("inviteEmail", errors.email, true)}
            />
          </Field>
          <Field id="inviteDays" label="Expires in" error={errors.days}>
            <Select
              // Intentional: React applies a <select>'s defaultValue only on mount, and resets the form after each
              // action; remounting on the echoed value keeps the choice after a failed submit.
              key={days}
              id="inviteDays"
              name="days"
              defaultValue={days}
              {...fieldA11y("inviteDays", errors.days)}
            >
              {INVITE_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </Field>
          {/* On wide screens, centres the button on the inputs below their labels. */}
          <div className="sm:pt-7">
            <SubmitButton pendingLabel="Creating…" className="w-full sm:w-auto">
              <Send aria-hidden />
              Create invite link
            </SubmitButton>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function CreatedInvite({ invite }: { invite: NonNullable<CreateInviteState["created"]> }) {
  return (
    <Alert tone="success" title={invite.email ? `Invite link for ${invite.email}` : "Invite link created"}>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input
          readOnly
          value={invite.url}
          aria-label="Signup link"
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton value={invite.url} />
      </div>
      <p className="mt-2">
        Copy this link now — for security it won&apos;t be shown again. It works once and expires{" "}
        <LocalTime iso={invite.expiresAt} />.
      </p>
    </Alert>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(button: HTMLButtonElement) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard API needs a secure context; fall back to selecting the link so the user can copy it by hand.
      button.parentElement?.querySelector("input")?.select();
    }
  }

  return (
    <Button variant="secondary" className="shrink-0" onClick={(e) => copy(e.currentTarget)}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
    </Button>
  );
}
