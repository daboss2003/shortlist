"use client";

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { CheckCircle2, FileText, Lock, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import { Alert, Spinner } from "@/components/ui/feedback";
import { Field, Input, Label } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { CV_ACCEPT, MAX_CV_BYTES } from "@/lib/cv/file-type";
import { formatBytes } from "@/lib/format";

type FieldName = "name" | "email" | "phone" | "cv" | "consent";
type FieldErrors = Partial<Record<FieldName, string>>;
type ApplyResponse = { ok?: boolean; error?: string; fieldErrors?: FieldErrors };

const FIELD_ORDER: FieldName[] = ["name", "email", "phone", "cv", "consent"];
const fieldId = (field: FieldName) => `apply-${field}`;
const SUCCESS_HEADING_ID = "apply-success-title";
const REMOVE_CV_ID = "apply-cv-remove";

const MAX_MB = MAX_CV_BYTES / (1024 * 1024);
const CV_EXTENSIONS = ["pdf", "docx", "txt"];
// Server (zod) is authoritative; these only catch the obvious before uploading a whole CV.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9 +\-().]*$/;

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";
const GENERIC_ERROR = "Something went wrong. Please try again.";

// Intentional: 16px text on phones — iOS Safari zooms the page into any focused field smaller than that.
const phoneSafeText = "max-sm:text-base";

function checkCvFile(file: File): string | null {
  const ext = file.name.includes(".") ? (file.name.toLowerCase().split(".").pop() ?? "") : "";
  if (ext === "doc") return "Older Word (.doc) files aren't supported. Please save your CV as .docx or PDF.";
  if (!CV_EXTENSIONS.includes(ext)) return "That file type isn't supported. Please upload a PDF, Word (.docx) or TXT file.";
  if (file.size === 0) return "That file is empty. Please choose another one.";
  if (file.size > MAX_CV_BYTES) {
    return `That file is ${formatBytes(file.size)}. Please upload a CV of ${MAX_MB} MB or less.`;
  }
  return null;
}

function validate(data: FormData, file: File | null): FieldErrors {
  const text = (key: string) => String(data.get(key) ?? "").trim();
  const errors: FieldErrors = {};
  if (!text("name")) errors.name = "Please enter your full name.";
  if (!text("email")) errors.email = "Please enter your email address.";
  else if (!EMAIL_PATTERN.test(text("email"))) errors.email = "Please enter a valid email address.";
  if (!PHONE_PATTERN.test(text("phone"))) {
    errors.phone = "Please enter a valid phone number using digits, spaces and + - ( ) . only.";
  }
  if (!file) errors.cv = "Please attach your CV.";
  if (data.get("consent") !== "on") errors.consent = "Please confirm you agree to share your CV.";
  return errors;
}

function without(errors: FieldErrors, field: FieldName): FieldErrors {
  if (!errors[field]) return errors;
  const next = { ...errors };
  delete next[field];
  return next;
}

export function ApplicationForm({
  slug,
  companyName,
  jobTitle,
}: {
  slug: string;
  companyName: string;
  jobTitle: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<{ firstName: string; email: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Element id to focus after the next render (the target may only exist once state has applied).
  const focusAfterRender = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterRender.current;
    if (!id) return;
    focusAfterRender.current = null;
    document.getElementById(id)?.focus();
  });

  // A file dropped anywhere else on the page would make the browser open it and lose the form.
  useEffect(() => {
    const block = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      if ((event.target as Element | null)?.closest?.("[data-cv-dropzone]")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  function showFieldErrors(errors: FieldErrors) {
    setFieldErrors(errors);
    const first = FIELD_ORDER.find((field) => errors[field]);
    if (first) focusAfterRender.current = fieldId(first);
  }

  function acceptFile(candidate: File | undefined) {
    if (!candidate) return;
    const problem = checkCvFile(candidate);
    if (problem) {
      setFile(null);
      setFieldErrors((errors) => ({ ...errors, cv: problem }));
      return;
    }
    setFile(candidate);
    setFieldErrors((errors) => without(errors, "cv"));
    // The dropzone (and its input) unmounts once a file is chosen; keep keyboard focus in the field.
    focusAfterRender.current = REMOVE_CV_ID;
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    acceptFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 1) {
      setFieldErrors((errors) => ({ ...errors, cv: "Please attach a single file: just your CV." }));
      return;
    }
    acceptFile(event.dataTransfer.files[0]);
  }

  function removeFile() {
    setFile(null);
    focusAfterRender.current = fieldId("cv");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const data = new FormData(event.currentTarget);
    setFormError(null);
    const errors = validate(data, file);
    if (Object.keys(errors).length > 0 || !file) {
      showFieldErrors(errors);
      return;
    }
    data.set("cv", file);
    setFieldErrors({});
    setPending(true);

    let response: Response;
    try {
      response = await fetch(`/api/apply/${encodeURIComponent(slug)}`, { method: "POST", body: data });
    } catch {
      setPending(false);
      setFormError(NETWORK_ERROR);
      return;
    }
    const body: ApplyResponse = await response.json().catch(() => ({}));
    setPending(false);

    if (response.ok) {
      const name = String(data.get("name")).trim();
      setSubmitted({ firstName: name.split(/\s+/)[0], email: String(data.get("email")).trim() });
      focusAfterRender.current = SUCCESS_HEADING_ID;
      return;
    }
    if (body.fieldErrors && Object.keys(body.fieldErrors).length > 0) {
      // The server rejected this file's contents; clear it so the dropzone is ready for another.
      if (body.fieldErrors.cv) setFile(null);
      showFieldErrors(body.fieldErrors);
      if (body.error) setFormError(body.error);
      return;
    }
    setFormError(body.error ?? GENERIC_ERROR);
  }

  const describedBy = (field: FieldName, hint?: boolean) =>
    fieldErrors[field] ? `${fieldId(field)}-error` : hint ? `${fieldId(field)}-hint` : undefined;

  const liveMessage = pending ? "Submitting your application…" : submitted ? "Application received." : "";

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {liveMessage}
      </p>

      {submitted ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
            <CheckCircle2 className="size-6" aria-hidden />
          </span>
          <h2 id={SUCCESS_HEADING_ID} tabIndex={-1} className="mt-4 text-lg font-semibold text-ink focus:outline-none">
            Application received
          </h2>
          <p className="mt-2 text-sm leading-6 text-ink-muted wrap-anywhere">
            Thanks, {submitted.firstName}. {companyName} has received your application for {jobTitle}. If they&apos;d
            like to move forward, they&apos;ll contact you at <span className="font-medium text-ink">{submitted.email}</span>.
          </p>
          <p className="mt-3 text-sm text-ink-faint">You can close this page.</p>
        </div>
      ) : (
        <>
          <CardHeader title="Apply for this role" />
          <form
            noValidate
            aria-busy={pending}
            onSubmit={handleSubmit}
            onChange={(event) => {
              const target: EventTarget = event.target;
              if (target instanceof HTMLInputElement && target.name) {
                setFieldErrors((errors) => without(errors, target.name as FieldName));
              }
            }}
            className="relative flex flex-col gap-5 px-5 py-5"
          >
            <Field id={fieldId("name")} label="Full name" error={fieldErrors.name}>
              <Input
                id={fieldId("name")}
                name="name"
                autoComplete="name"
                required
                maxLength={120}
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby={describedBy("name")}
                className={phoneSafeText}
              />
            </Field>

            <Field
              id={fieldId("email")}
              label="Email"
              hint="We'll only use this to contact you about this application."
              error={fieldErrors.email}
            >
              <Input
                id={fieldId("email")}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                required
                maxLength={200}
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={describedBy("email", true)}
                className={phoneSafeText}
              />
            </Field>

            <Field id={fieldId("phone")} label="Phone" optional error={fieldErrors.phone}>
              <Input
                id={fieldId("phone")}
                name="phone"
                type="tel"
                autoComplete="tel"
                maxLength={40}
                aria-invalid={Boolean(fieldErrors.phone)}
                aria-describedby={describedBy("phone")}
                className={phoneSafeText}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId("cv")}>CV</Label>
              {file ? (
                <div className="flex items-center gap-3 rounded-lg border border-line-strong bg-surface px-3 py-2.5 shadow-xs">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink" title={file.name}>
                      {file.name}
                    </p>
                    <p className="text-xs text-ink-muted tabular-nums">{formatBytes(file.size)}</p>
                  </div>
                  <Button
                    id={REMOVE_CV_ID}
                    variant="ghost"
                    size="sm"
                    onClick={removeFile}
                    disabled={pending}
                    aria-label={`Remove ${file.name}`}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <div
                  data-cv-dropzone
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                  }}
                  onDrop={handleDrop}
                  className={cn(
                    "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
                    "has-focus:border-brand has-focus:outline-2 has-focus:outline-brand/25",
                    dragging
                      ? "border-brand bg-brand-soft"
                      : fieldErrors.cv
                        ? "border-danger hover:bg-subtle"
                        : "border-line-strong hover:border-ink-faint hover:bg-subtle",
                  )}
                >
                  <input
                    ref={fileInputRef}
                    id={fieldId("cv")}
                    type="file"
                    accept={CV_ACCEPT}
                    required
                    className="sr-only"
                    aria-invalid={Boolean(fieldErrors.cv)}
                    aria-describedby={
                      fieldErrors.cv ? `${fieldId("cv")}-error ${fieldId("cv")}-hint` : `${fieldId("cv")}-hint`
                    }
                    onChange={handleFileInput}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.currentTarget.click();
                      }
                    }}
                  />
                  <span className="flex size-10 items-center justify-center rounded-full bg-subtle text-ink-muted">
                    <Upload className="size-5" aria-hidden />
                  </span>
                  <span className="text-sm text-ink">
                    <span className="font-medium text-brand-ink">Choose a file</span> or drag it here
                  </span>
                  <span id={`${fieldId("cv")}-hint`} className="text-xs text-ink-muted">
                    PDF, Word (.docx) or TXT · up to {MAX_MB} MB
                  </span>
                </div>
              )}
              {fieldErrors.cv && (
                <p id={`${fieldId("cv")}-error`} className="text-sm text-danger">
                  {fieldErrors.cv}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-start gap-3">
                <input
                  id={fieldId("consent")}
                  name="consent"
                  type="checkbox"
                  required
                  aria-invalid={Boolean(fieldErrors.consent)}
                  aria-describedby={describedBy("consent")}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                />
                <label htmlFor={fieldId("consent")} className="cursor-pointer text-sm leading-5 text-ink-muted">
                  I agree that {companyName} may store and review my CV to assess my application.
                </label>
              </div>
              {fieldErrors.consent && (
                <p id={`${fieldId("consent")}-error`} className="pl-7 text-sm text-danger">
                  {fieldErrors.consent}
                </p>
              )}
            </div>

            {/* Intentional: honeypot — off-screen rather than display:none so naive bots still fill it in. Its name and
                label are meaningless on purpose: a "company"/"website" name gets autofilled by browsers, which would
                silently drop real applications. */}
            <div aria-hidden className="absolute top-0 left-[-9999px] size-px overflow-hidden">
              <label htmlFor="apply-hp">Leave this field empty</label>
              <input
                id="apply-hp"
                name="hp_x7q"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                defaultValue=""
                aria-hidden
              />
            </div>

            {formError && <Alert tone="danger" title={formError} />}

            <div className="flex flex-col gap-3">
              <Button type="submit" size="lg" disabled={pending} className="w-full [&_svg]:text-white">
                {pending ? (
                  <>
                    <Spinner label="Submitting" />
                    Submitting…
                  </>
                ) : (
                  "Submit application"
                )}
              </Button>
              <p className="flex items-start gap-2 text-sm text-ink-muted">
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  Your CV is shared only with {companyName} for this role. Applications may be screened with the help
                  of AI.
                </span>
              </p>
            </div>
          </form>
        </>
      )}
    </>
  );
}
