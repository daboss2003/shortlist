"use client";

import { useActionState, useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Field, Select } from "@/components/ui/field";
import { fieldA11y } from "../_components/field-a11y";
import { SubmitButton } from "../_components/submit-button";
import { useFreshResult } from "../_components/use-fresh-result";
import { updateRetentionAction, type RetentionState } from "./actions";
import { FormFooter } from "./company-profile-form";

const initialState: RetentionState = {};
const OFF = "off";
const toValue = (days: number | null) => (days === null ? OFF : String(days));

export function RetentionForm({ saved, options }: { saved: number | null; options: readonly number[] }) {
  const [state, formAction] = useActionState(updateRetentionAction, initialState);
  const fresh = useFreshResult(state);
  const savedValue = toValue(saved);

  // The selection drives the explanation below the select; it follows the saved value when that changes.
  const [choice, setChoice] = useState(savedValue);
  const [prevSaved, setPrevSaved] = useState(savedValue);
  if (prevSaved !== savedValue) {
    setPrevSaved(savedValue);
    setChoice(savedValue);
  }

  const chosenDays = choice === OFF ? null : Number(choice);
  const shortening = choice !== savedValue && chosenDays !== null && (saved === null || chosenDays < saved);

  return (
    <Card>
      <form action={formAction} noValidate>
        <CardHeader
          title="Candidate data retention"
          description="How long CVs and candidate profiles are kept once a job closes."
        />
        <CardBody className="space-y-5 py-5">
          <Field
            id="retentionDays"
            label="Delete candidate data after"
            hint={
              chosenDays === null
                ? "CVs are kept until you delete them."
                : "When a job has been closed for this long, its candidates' CVs and profiles are permanently deleted. Reopening a job stops the clock."
            }
            error={state.error}
            className="sm:max-w-xs"
          >
            <Select
              // Intentional: React applies a <select>'s defaultValue only on mount, and resets the form after each
              // action; remounting on the saved value keeps the select showing what was saved.
              key={savedValue}
              id="retentionDays"
              name="retentionDays"
              defaultValue={savedValue}
              onChange={(e) => setChoice(e.target.value)}
              {...fieldA11y("retentionDays", state.error, true)}
            >
              <option value={OFF}>Off</option>
              {options.map((days) => (
                <option key={days} value={String(days)}>
                  {days} days
                </option>
              ))}
            </Select>
          </Field>
          {shortening && (
            <Alert tone="warning" title="This applies to jobs that are already closed">
              Candidates on jobs closed more than {chosenDays} days ago will be permanently deleted within an hour of
              saving.
            </Alert>
          )}
        </CardBody>
        <FormFooter saved={fresh && state.ok === true} savedLabel="Retention period saved.">
          <SubmitButton pendingLabel="Saving…">Save retention</SubmitButton>
        </FormFooter>
      </form>
    </Card>
  );
}
