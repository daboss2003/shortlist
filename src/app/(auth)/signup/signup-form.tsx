"use client";

import { useActionState, useEffect, useRef } from "react";
import { Alert } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/field";
import { fieldA11y } from "@/app/dashboard/_components/field-a11y";
import { SubmitButton } from "@/app/dashboard/_components/submit-button";
import { signupAction, type SignupState } from "../actions";

const initialState: SignupState = {};

export function SignupForm({ inviteToken, invitedEmail }: { inviteToken: string; invitedEmail: string | null }) {
  const [state, formAction] = useActionState(signupAction, initialState);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.fieldErrors) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-5">
      {state.formError && <Alert tone="danger" title={state.formError} />}
      <input type="hidden" name="invite" value={inviteToken} />

      <Field id="companyName" label="Company name" error={errors.companyName}>
        <Input
          id="companyName"
          name="companyName"
          autoComplete="organization"
          required
          maxLength={120}
          defaultValue={values.companyName}
          {...fieldA11y("companyName", errors.companyName)}
        />
      </Field>

      <Field
        id="website"
        label="Company website"
        optional
        hint="Shown to applicants so they know the role is genuine."
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

      <Field id="name" label="Your name" error={errors.name}>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          required
          maxLength={120}
          defaultValue={values.name}
          {...fieldA11y("name", errors.name)}
        />
      </Field>

      <Field
        id="email"
        label="Work email"
        hint={invitedEmail ? "This invite is for this email address." : undefined}
        error={errors.email}
      >
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={200}
          // The server only redeems an email-bound invite for that email; locking the field just says so up front.
          readOnly={invitedEmail !== null}
          className="read-only:bg-subtle read-only:text-ink-muted"
          defaultValue={invitedEmail ?? values.email}
          {...fieldA11y("email", errors.email, invitedEmail !== null)}
        />
      </Field>

      <Field id="password" label="Password" hint="At least 8 characters" error={errors.password}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={200}
          {...fieldA11y("password", errors.password, true)}
        />
      </Field>

      <SubmitButton className="w-full" size="lg" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  );
}
