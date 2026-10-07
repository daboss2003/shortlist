"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { fieldA11y } from "../_components/field-a11y";
import { SubmitButton } from "../_components/submit-button";
import { useFreshResult } from "../_components/use-fresh-result";
import { updateCompanyProfileAction, type CompanyProfileState } from "./actions";

const initialState: CompanyProfileState = {};

export function CompanyProfileForm({ defaults }: { defaults: { name: string; website: string } }) {
  const [state, formAction] = useActionState(updateCompanyProfileAction, initialState);
  const fresh = useFreshResult(state);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? defaults;
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.fieldErrors) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state]);

  return (
    <Card>
      <form ref={formRef} action={formAction} noValidate>
        <CardHeader title="Company profile" description="Shown to applicants on your job pages." />
        <CardBody className="space-y-5 py-5">
          <Field id="companyName" label="Company name" error={errors.name}>
            <Input
              id="companyName"
              name="name"
              autoComplete="organization"
              required
              maxLength={120}
              defaultValue={values.name}
              {...fieldA11y("companyName", errors.name)}
            />
          </Field>
          <Field
            id="website"
            label="Company website"
            optional
            hint="Helps applicants check the role is genuine."
            error={errors.website}
          >
            <Input
              id="website"
              name="website"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="acme.com"
              maxLength={200}
              defaultValue={values.website}
              {...fieldA11y("website", errors.website, true)}
            />
          </Field>
        </CardBody>
        <FormFooter saved={fresh && state.ok === true} savedLabel="Company profile saved.">
          <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
        </FormFooter>
      </form>
    </Card>
  );
}

/** Card footer: a short-lived success line on the left, the submit button on the right. */
export function FormFooter({
  saved,
  savedLabel,
  children,
}: {
  saved: boolean;
  savedLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-3 border-t border-line px-5 py-4">
      <p role="status" className="mr-auto flex items-center gap-1.5 text-sm text-success">
        {saved && (
          <>
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            {savedLabel}
          </>
        )}
      </p>
      {children}
    </div>
  );
}
