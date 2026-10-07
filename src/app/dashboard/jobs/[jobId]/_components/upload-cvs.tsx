"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CloudUpload, CopyCheck, FileText, Loader2, Lock, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, Spinner } from "@/components/ui/feedback";
import { cn } from "@/lib/cn";
import { CV_ACCEPT, CV_FILE_TYPES, MAX_CV_BYTES } from "@/lib/cv/file-type";
import { formatBytes } from "@/lib/format";
import type { UploadResponse } from "@/app/api/jobs/[jobId]/candidates/route";
import { useAnnounce } from "./announcer";
import { UPLOAD_DROPZONE_ID, UPLOAD_MORE_ID, UPLOAD_SECTION_ID } from "./job-header-actions";
import { useRestoreFocus } from "./use-restore-focus";

const MAX_BATCH_FILES = 50;
// Intentional: one CV per request, two requests at a time. Netlify Functions accept ~4.5 MB of binary per
// request, so the server takes exactly one file; two in parallel keep a batch moving without hogging the uplink.
const UPLOAD_CONCURRENCY = 2;
const MAX_MB = MAX_CV_BYTES / (1024 * 1024);
const RETRY_ID = "upload-cvs-retry";
const CLOSED_MESSAGE = "This job is closed. Reopen it to add CVs.";

type ItemStatus =
  | { kind: "queued" }
  | { kind: "invalid"; error: string }
  | { kind: "sending" }
  | { kind: "added" }
  /** An identical file is already in this job. Neutral: not a failure, not retryable. */
  | { kind: "duplicate" }
  | { kind: "failed"; error: string };

type Item = { key: string; file: File; status: ItemStatus };

type Fatal = { message: string; retryable: boolean; jobClosed?: boolean };

type UploadResult = UploadResponse["results"][number];

type SendOutcome =
  | { type: "result"; result: UploadResult }
  /** This file was refused (e.g. too large for the server); the rest of the batch carries on. */
  | { type: "file-error"; error: string }
  /** Nothing more can be sent until the user acts (signed out, job closed or gone, server down). */
  | { type: "fatal"; fatal: Fatal };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const isDuplicate = (result: UploadResult) => !result.ok && "code" in result && result.code === "duplicate";

function clientError(file: File): string | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (!(CV_FILE_TYPES as readonly string[]).includes(ext)) return "Unsupported file type. Use PDF, Word (.doc, .docx) or plain text.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_CV_BYTES) return `Larger than ${MAX_MB} MB.`;
  return null;
}

async function errorMessage(res: Response): Promise<string | undefined> {
  const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
  return typeof error === "string" && error ? error : undefined;
}

async function send(jobId: string, file: File): Promise<SendOutcome> {
  const body = new FormData();
  body.append("files", file, file.name);

  let res: Response;
  try {
    res = await fetch(`/api/jobs/${jobId}/candidates`, { method: "POST", body });
  } catch {
    return { type: "fatal", fatal: { message: "The upload was interrupted. Check your connection and try again.", retryable: true } };
  }

  if (res.ok) {
    const data = (await res.json().catch(() => null)) as UploadResponse | null;
    if (data && Array.isArray(data.results) && data.results.length === 1) {
      return { type: "result", result: data.results[0] };
    }
    return { type: "fatal", fatal: { message: "The server sent an unexpected response. Try again.", retryable: true } };
  }
  if (res.status === 401) {
    return { type: "fatal", fatal: { message: "Your session has expired. Sign in again in a new tab, then try again.", retryable: true } };
  }
  if (res.status === 404) {
    return { type: "fatal", fatal: { message: "This job no longer exists, so the CVs can't be added.", retryable: false } };
  }
  if (res.status === 409) {
    // The job was closed after this page loaded (another tab or teammate).
    return { type: "fatal", fatal: { message: (await errorMessage(res)) ?? CLOSED_MESSAGE, retryable: false, jobClosed: true } };
  }
  if (res.status >= 500) {
    return { type: "fatal", fatal: { message: "Something went wrong on our side. The remaining CVs weren't uploaded.", retryable: true } };
  }
  if (res.status === 413) return { type: "file-error", error: (await errorMessage(res)) ?? `Larger than ${MAX_MB} MB.` };
  return { type: "file-error", error: (await errorMessage(res)) ?? "This file couldn't be uploaded." };
}

function summarize(added: number, duplicates: number, failed: number) {
  const tone: "success" | "info" | "warning" | "danger" =
    failed === 0 ? (added > 0 ? "success" : "info") : added > 0 ? "warning" : "danger";
  const title =
    failed === 0
      ? added > 0
        ? `${plural(added, "CV")} added`
        : "No new CVs to add"
      : added > 0
        ? `${added} of ${added + failed} CVs added`
        : "No CVs were added";
  const body = [
    added > 0 && "They're being analyzed now — scores appear in the candidate list as they're ready.",
    duplicates > 0 &&
      (duplicates === 1
        ? "1 file was already in this job, so it was skipped."
        : `${duplicates} files were already in this job, so they were skipped.`),
    failed > 0 && (added > 0 ? "Check the files marked below." : "Check the files marked below, then try again."),
  ].filter(Boolean);
  return { tone, title, body: body.join(" ") };
}

export function UploadCvsCard({ jobId, closed }: { jobId: string; closed: boolean }) {
  const router = useRouter();
  const announce = useAnnounce();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const restoreFocus = useRestoreFocus(!uploading);

  // A "job is closed" stop no longer applies once the job is reopened.
  const [prevClosed, setPrevClosed] = useState(closed);
  if (closed !== prevClosed) {
    setPrevClosed(closed);
    if (!closed && fatal?.jobClosed) setFatal(null);
  }

  // A file dropped outside the drop zone would make the browser open it and leave the page.
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

  const queued = items.filter((i) => i.status.kind === "queued");
  const added = items.filter((i) => i.status.kind === "added").length;
  const duplicates = items.filter((i) => i.status.kind === "duplicate").length;
  const notAdded = items.filter((i) => i.status.kind === "failed" || i.status.kind === "invalid").length;
  const attempted = items.some((i) => i.status.kind === "added" || i.status.kind === "failed" || i.status.kind === "duplicate");
  const done = !uploading && queued.length === 0 && attempted;
  const showFatal = fatal && !(fatal.jobClosed && closed);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const next = [...items];
    const seen = new Set(next.map((i) => i.key));
    let skipped = 0;
    for (const file of Array.from(list)) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) continue;
      if (next.length >= MAX_BATCH_FILES) {
        skipped++;
        continue;
      }
      seen.add(key);
      const error = clientError(file);
      next.push({ key, file, status: error ? { kind: "invalid", error } : { kind: "queued" } });
    }
    const overflow =
      skipped > 0
        ? `Only ${MAX_BATCH_FILES} files fit in one batch — ${plural(skipped, "file")} weren't added. Upload them after this batch.`
        : null;
    setItems(next);
    setFatal(null);
    setNotice(overflow);
    if (overflow) announce(overflow);
  }

  function remove(key: string) {
    setItems((prev) => prev.filter((i) => i.key !== key));
    setNotice(null);
  }

  function reset() {
    setItems([]);
    setNotice(null);
    setFatal(null);
    setProgress({ done: 0, total: 0 });
    restoreFocus(UPLOAD_DROPZONE_ID, UPLOAD_SECTION_ID);
  }

  function setStatus(key: string, status: ItemStatus) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, status } : item)));
  }

  async function upload() {
    const queue = items.filter((i) => i.status.kind === "queued");
    if (queue.length === 0) return;
    setUploading(true);
    setFatal(null);
    setNotice(null);
    setProgress({ done: 0, total: queue.length });
    announce(`Uploading ${plural(queue.length, "CV")}…`);

    // Earlier runs of this batch (before a "Try again") count towards the final summary too.
    const count = (kind: ItemStatus["kind"]) => items.filter((i) => i.status.kind === kind).length;
    // An object, not `let`s: the workers below update it across awaits, which TypeScript's narrowing ignores.
    const run = { next: 0, sent: 0, created: 0, skipped: 0, failed: count("failed") + count("invalid"), stopped: false };

    // Each worker takes the next queued file until the queue is empty or the batch is stopped. Requests already in
    // flight when another one stops the batch still finish and report their own result.
    async function worker() {
      while (!run.stopped && run.next < queue.length) {
        const item = queue[run.next++];
        setStatus(item.key, { kind: "sending" });
        const outcome = await send(jobId, item.file);

        if (outcome.type === "fatal") {
          setStatus(item.key, { kind: "queued" });
          if (!run.stopped) {
            run.stopped = true;
            setFatal(outcome.fatal);
            if (outcome.fatal.jobClosed) router.refresh();
          }
          return;
        }
        if (outcome.type === "file-error") {
          setStatus(item.key, { kind: "failed", error: outcome.error });
          run.failed++;
        } else if (outcome.result.ok) {
          setStatus(item.key, { kind: "added" });
          run.created++;
        } else if (isDuplicate(outcome.result)) {
          setStatus(item.key, { kind: "duplicate" });
          run.skipped++;
        } else {
          setStatus(item.key, { kind: "failed", error: outcome.result.error });
          run.failed++;
        }
        run.sent++;
        setProgress({ done: run.sent, total: queue.length });
        if (run.sent < queue.length) announce(`Uploaded ${run.sent} of ${queue.length}`);
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
    } finally {
      setUploading(false);
      restoreFocus(UPLOAD_MORE_ID, RETRY_ID, UPLOAD_SECTION_ID);
      if (run.created > 0) router.refresh();
    }

    // A stopped upload is reported by its alert (role="alert"); otherwise read out the same summary that's shown.
    if (!run.stopped) {
      const summary = summarize(count("added") + run.created, count("duplicate") + run.skipped, run.failed);
      announce(`${summary.title}. ${summary.body}`);
    }
  }

  function onDragOver(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  }

  function onDragLeave(e: DragEvent<HTMLButtonElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  }

  function onDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }

  const summary = done ? summarize(added, duplicates, notAdded) : null;

  return (
    <Card id={UPLOAD_SECTION_ID} tabIndex={-1} className="scroll-mt-6 focus:outline-none">
      <CardHeader
        title="Upload CVs"
        description="Add CVs you already have. Each one is analyzed and ranked against this job."
      />
      <CardBody className="space-y-4">
        {closed && !uploading ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-line bg-subtle/50 px-6 py-8 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-surface text-ink-muted ring-1 ring-line">
              <Lock className="size-5" aria-hidden />
            </span>
            <p className="text-sm font-medium text-ink">This job is closed.</p>
            <p className="text-xs text-ink-muted">Reopen it to add CVs.</p>
          </div>
        ) : (
          !uploading &&
          !done && (
            <>
              <button
                type="button"
                id={UPLOAD_DROPZONE_ID}
                data-cv-dropzone
                onClick={() => inputRef.current?.click()}
                onDragEnter={onDragOver}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={cn(
                  "group flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                  dragging ? "border-brand bg-brand-soft" : "border-line-strong bg-subtle/50 hover:border-ink-faint hover:bg-subtle",
                )}
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-surface text-ink-muted ring-1 ring-line">
                  <CloudUpload className="size-5" aria-hidden />
                </span>
                <span className="text-sm font-medium text-ink">
                  {dragging ? (
                    "Drop to add these CVs"
                  ) : (
                    <>
                      Drop CVs here or <span className="text-brand-ink group-hover:underline">browse files</span>
                    </>
                  )}
                </span>
                <span className="text-xs text-ink-muted">
                  PDF, Word (.doc, .docx) or plain text · up to {MAX_MB} MB each
                </span>
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={CV_ACCEPT}
                tabIndex={-1}
                aria-hidden
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.currentTarget.files);
                  // Allow picking the same file again after removing it.
                  e.currentTarget.value = "";
                }}
              />
            </>
          )
        )}

        {notice && <p className="text-sm text-warning">{notice}</p>}

        {showFatal && (
          <Alert
            tone="danger"
            title="Upload stopped"
            action={
              fatal.retryable && queued.length > 0 ? (
                <Button id={RETRY_ID} variant="secondary" size="sm" onClick={upload}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {fatal.message}
            {added > 0 && ` ${plural(added, "CV")} ${added === 1 ? "was" : "were"} added before it stopped.`}
          </Alert>
        )}

        {summary && (
          <Alert tone={summary.tone} title={summary.title}>
            {summary.body}
          </Alert>
        )}

        {items.length > 0 && (
          <ul
            aria-label="Selected CVs"
            className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line"
          >
            {items.map((item) => (
              <FileRow
                key={item.key}
                item={item}
                onRemove={
                  !uploading && (item.status.kind === "queued" || item.status.kind === "invalid")
                    ? () => remove(item.key)
                    : undefined
                }
              />
            ))}
          </ul>
        )}

        {(items.length > 0 || uploading) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {uploading ? (
              <Button disabled>
                <Loader2 className="animate-spin" aria-hidden />
                Uploading… {progress.done} of {progress.total}
              </Button>
            ) : done && !closed ? (
              <Button id={UPLOAD_MORE_ID} variant="secondary" onClick={reset}>
                Upload more CVs
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={reset}>
                  Clear
                </Button>
                {!fatal && !closed && !done && (
                  <Button onClick={upload} disabled={queued.length === 0}>
                    Upload {plural(queued.length, "CV")}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function FileRow({ item, onRemove }: { item: Item; onRemove?: () => void }) {
  const { file, status } = item;
  const failed = status.kind === "failed" || status.kind === "invalid";

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {status.kind === "sending" ? (
          <Spinner label="Uploading" />
        ) : status.kind === "added" ? (
          <CheckCircle2 className="size-4 text-success" aria-label="Added" />
        ) : status.kind === "duplicate" ? (
          <CopyCheck className="size-4 text-ink-muted" aria-hidden />
        ) : failed ? (
          <XCircle className="size-4 text-danger" aria-label="Not added" />
        ) : (
          <FileText className="size-4 text-ink-faint" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink" title={file.name}>
          {file.name}
        </p>
        <p className={cn("text-xs", failed ? "text-danger" : status.kind === "added" ? "text-success" : "text-ink-muted")}>
          {status.kind === "added"
            ? "Added"
            : status.kind === "duplicate"
              ? "Already in this job"
              : failed
                ? status.error
                : status.kind === "sending"
                  ? `Uploading · ${formatBytes(file.size)}`
                  : formatBytes(file.size)}
        </p>
      </div>
      {onRemove && (
        <Button variant="ghost" size="sm" className="w-8 px-0" onClick={onRemove} aria-label={`Remove ${file.name}`}>
          <X aria-hidden />
        </Button>
      )}
    </li>
  );
}
