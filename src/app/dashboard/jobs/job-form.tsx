"use client";

import { useActionState, useEffect, useRef } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import type { EmploymentType } from "@/db/schema";
import { EMPLOYMENT_TYPE_LABELS } from "@/lib/format";
import type { JobField } from "@/lib/jobs/service";
import { fieldA11y } from "../_components/field-a11y";
import { SubmitButton } from "../_components/submit-button";
import type { JobFormState } from "./actions";

// Client-side mirror of JOB_LIMITS in src/lib/jobs/service.ts (server-only); the server re-validates everything.
const MAX = { title: 120, department: 120, location: 120, text: 20_000 } as const;

const EMPLOYMENT_TYPE_OPTIONS = Object.entries(EMPLOYMENT_TYPE_LABELS) as [EmploymentType, string][];

export type JobFormValues = Partial<Record<JobField, string>>;

export function JobForm({
  action,
  defaults = {},
  submitLabel,
  pendingLabel,
  cancelHref,
}: {
  action: (prev: JobFormState, formData: FormData) => Promise<JobFormState>;
  defaults?: JobFormValues;
  submitLabel: string;
  pendingLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const errors = state.fieldErrors ?? {};
  const values: JobFormValues = state.values ?? defaults;
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.fieldErrors) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-6">
      {state.fieldErrors && <Alert tone="danger" title="Some details need fixing. Check the highlighted fields." />}

      <Card>
        <CardHeader title="Basics" description="What applicants see first on the application page." />
        <CardBody className="grid gap-5 py-5 sm:grid-cols-2">
          <Field id="title" label="Job title" error={errors.title} className="sm:col-span-2">
            <Input
              id="title"
              name="title"
              required
              maxLength={MAX.title}
              placeholder="e.g. Senior Backend Engineer"
              defaultValue={values.title}
              {...fieldA11y("title", errors.title)}
            />
          </Field>
          <Field id="department" label="Department" optional error={errors.department}>
            <Input
              id="department"
              name="department"
              maxLength={MAX.department}
              placeholder="e.g. Engineering"
              defaultValue={values.department}
              {...fieldA11y("department", errors.department)}
            />
          </Field>
          <Field id="location" label="Location" optional error={errors.location}>
            <Input
              id="location"
              name="location"
              maxLength={MAX.location}
              placeholder="e.g. Lagos, Nigeria · Hybrid"
              defaultValue={values.location}
              {...fieldA11y("location", errors.location)}
            />
          </Field>
          <Field id="employmentType" label="Employment type" optional error={errors.employmentType}>
            <Select
              // Intentional: React applies a <select>'s defaultValue only on mount, and resets the form after each
              // action; remounting on the echoed value keeps the user's choice after a failed submit.
              key={values.employmentType ?? ""}
              id="employmentType"
              name="employmentType"
              defaultValue={values.employmentType ?? ""}
              {...fieldA11y("employmentType", errors.employmentType)}
            >
              <option value="">Not specified</option>
              {EMPLOYMENT_TYPE_OPTIONS.map(([type, label]) => (
                <option key={type} value={type}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What you're looking for"
          description="The AI ranks every CV against the description, requirements and key skills — the more specific, the better the ranking."
        />
        <CardBody className="grid gap-5 py-5 sm:grid-cols-3">
          <Field
            id="description"
            label="Description"
            hint="Shown to applicants. Cover the responsibilities, the team and what success looks like."
            error={errors.description}
            className="sm:col-span-3"
          >
            <Textarea
              id="description"
              name="description"
              required
              rows={10}
              maxLength={MAX.text}
              defaultValue={values.description}
              {...fieldA11y("description", errors.description, true)}
            />
          </Field>
          <Field
            id="requirements"
            label="Requirements"
            optional
            hint="Must-haves and nice-to-haves, one per line. Also shown to applicants."
            error={errors.requirements}
            className="sm:col-span-3"
          >
            <Textarea
              id="requirements"
              name="requirements"
              rows={6}
              maxLength={MAX.text}
              defaultValue={values.requirements}
              {...fieldA11y("requirements", errors.requirements, true)}
            />
          </Field>
          <Field
            id="skills"
            label="Key skills"
            optional
            hint="Separate with commas, up to 30."
            error={errors.skills}
            className="sm:col-span-2"
          >
            <Input
              id="skills"
              name="skills"
              placeholder="e.g. TypeScript, PostgreSQL, AWS"
              defaultValue={values.skills}
              {...fieldA11y("skills", errors.skills, true)}
            />
          </Field>
          <Field id="minExperienceYears" label="Minimum experience" optional hint="In years." error={errors.minExperienceYears}>
            <Input
              id="minExperienceYears"
              name="minExperienceYears"
              type="number"
              inputMode="numeric"
              min={0}
              max={50}
              step={1}
              placeholder="e.g. 3"
              defaultValue={values.minExperienceYears}
              {...fieldA11y("minExperienceYears", errors.minExperienceYears, true)}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
