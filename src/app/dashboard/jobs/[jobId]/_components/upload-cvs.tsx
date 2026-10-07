"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CloudUpload, FileText, Loader2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, Spinner } from "@/components/ui/feedback";
import { cn } from "@/lib/cn";
import { CV_ACCEPT, CV_FILE_TYPES, MAX_CV_BYTES } from "@/lib/cv/file-type";
import { formatBytes } from "@/lib/format";
import type { UploadResponse } from "@/app/api/jobs/[jobId]/candidates/route";
import { UPLOAD_DROPZONE_ID, UPLOAD_SECTION_ID } from "./job-header-actions";

const MAX_BATCH_FILES = 50;
// Intentional: a batch is sent as several small requests. A proxy buffers request bodies only up to
// 10 MB (proxyClientMaxBodySize) and silently truncates the rest; small requests also give progress.
const MAX_REQUEST_FILES = 10;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

type ItemStatus =
  | { kind: "queued" }
  | { kind: "invalid"; error: string }
  | { kind: "sending" }
  | { kind: "added" }
  | { kind: "failed"; error: string };

type Item = { key: string; file: File; status: ItemStatus };

type Fatal = { message: string; retryable: boolean };

type SendOutcome =
  | { type: "results"; results: UploadResponse["results"] }
  | { type: "batch-error"; error: string }
  | { type: "fatal"; fatal: Fatal };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function clientError(file: File): string | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (!(CV_FILE_TYPES as readonly string[]).includes(ext)) return "Unsupported file type. Use PDF, Word (.docx) or plain text.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_CV_BYTES) return `Larger than ${formatBytes(MAX_CV_BYTES)}.`;
  return null;
}

function toRequests(queue: Item[]): Item[][] {
  const groups: Item[][] = [];
  let group: Item[] = [];
  let bytes = 0;
  for (const item of queue) {
    if (group.length > 0 && (group.length >= MAX_REQUEST_FILES || bytes + item.file.size > MAX_REQUEST_BYTES)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(item);
    bytes += item.file.size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

async function send(jobId: string, group: Item[]): Promise<SendOutcome> {
  const body = new FormData();
  for (const item of group) body.append("files", item.file, item.file.name);

  let res: Response;
  try {
    res = await fetch(`/api/jobs/${jobId}/candidates`, { method: "POST", body });
  } catch {
    return { type: "fatal", fatal: { message: "The upload was interrupted. Check your connection and try again.", retryable: true } };
  }

  if (res.ok) {
    const data = (await res.json().catch(() => null)) as UploadResponse | null;
    if (data && Array.isArray(data.results) && data.results.length === group.length) {
      return { type: "results", results: data.results };
    }
    return { type: "fatal", fatal: { message: "The server sent an unexpected response. Try again.", retryable: true } };
  }
  if (res.status === 401) {
    return { type: "fatal", fatal: { message: "Your session has expired. Sign in again in a new tab, then try again.", retryable: true } };
  }
  if (res.status === 404) {
    return { type: "fatal", fatal: { message: "This job no longer exists, so the CVs can't be added.", retryable: false } };
  }
  if (res.status >= 500) {
    return { type: "fatal", fatal: { message: "Something went wrong on our side. The remaining CVs weren't uploaded.", retryable: true } };
  }
  const error = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
  return { type: "batch-error", error: error ?? "This file couldn't be uploaded." };
}

export function UploadCvsCard({ jobId }: { jobId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const [fatal, setFatal] = useState<Fatal | null>(null);

  const queued = items.filter((i) => i.status.kind === "queued");
  const added = items.filter((i) => i.status.kind === "added").length;
  const notAdded = items.filter((i) => i.status.kind === "failed" || i.status.kind === "invalid").length;
  const attempted = items.some((i) => i.status.kind === "added" || i.status.kind === "failed");
  const done = !uploading && queued.length === 0 && attempted;

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
    setItems(next);
    setFatal(null);
    setNotice(
      skipped > 0
        ? `Only ${MAX_BATCH_FILES} files fit in one batch — ${plural(skipped, "file")} weren't added. Upload them after this batch.`
        : null,
    );
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
  }

  function setStatus(keys: Set<string>, status: (item: Item, index: number) => ItemStatus) {
    setItems((prev) => {
      let index = -1;
      return prev.map((item) => (keys.has(item.key) ? { ...item, status: status(item, ++index) } : item));
    });
  }

  async function upload() {
    const queue = items.filter((i) => i.status.kind === "queued");
    if (queue.length === 0) return;
    setUploading(true);
    setFatal(null);
    setNotice(null);
    setProgress({ done: 0, total: queue.length });

    let created = 0;
    let sent = 0;
    try {
      for (const group of toRequests(queue)) {
        const keys = new Set(group.map((i) => i.key));
        setStatus(keys, () => ({ kind: "sending" }));
        const outcome = await send(jobId, group);

        if (outcome.type === "fatal") {
          setStatus(keys, () => ({ kind: "queued" }));
          setFatal(outcome.fatal);
          break;
        }
        if (outcome.type === "batch-error") {
          setStatus(keys, () => ({ kind: "failed", error: outcome.error }));
        } else {
          // Results come back in the order the files were sent; `group` preserves list order.
          setStatus(keys, (_item, i) => {
            const result = outcome.results[i];
            return result.ok ? { kind: "added" } : { kind: "failed", error: result.error };
          });
          created += outcome.results.filter((r) => r.ok).length;
        }
        sent += group.length;
        setProgress({ done: sent, total: queue.length });
      }
    } finally {
      setUploading(false);
      if (created > 0) router.refresh();
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

  return (
    <Card id={UPLOAD_SECTION_ID} className="scroll-mt-6">
      <CardHeader
        title="Upload CVs"
        description="Add CVs you already have. Each one is analyzed and ranked against this job."
      />
      <CardBody className="space-y-4">
        {!uploading && !done && (
          <>
            <button
              type="button"
              id={UPLOAD_DROPZONE_ID}
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
                PDF, Word (.docx) or plain text · up to {formatBytes(MAX_CV_BYTES)} each · {MAX_BATCH_FILES} files per batch
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
        )}

        {notice && (
          <p role="status" className="text-sm text-warning">
            {notice}
          </p>
        )}

        {fatal && (
          <Alert
            tone="danger"
            title="Upload stopped"
            action={
              fatal.retryable && queued.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={upload}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {fatal.message}
            {added > 0 && ` ${plural(added, "CV")} ${added === 1 ? "was" : "were"} added before it stopped.`}
          </Alert>
        )}

        {done && (
          <Alert
            tone={notAdded === 0 ? "success" : added > 0 ? "warning" : "danger"}
            title={
              notAdded === 0
                ? `${plural(added, "CV")} added`
                : added > 0
                  ? `${added} of ${added + notAdded} CVs added`
                  : "No CVs were added"
            }
          >
            {added > 0
              ? "They're being analyzed now — scores appear in the candidate list as they're ready."
              : "Check the files marked below, then try again."}
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
            ) : done ? (
              <Button variant="secondary" onClick={reset}>
                Upload more CVs
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={reset}>
                  Clear
                </Button>
                {!fatal && (
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
