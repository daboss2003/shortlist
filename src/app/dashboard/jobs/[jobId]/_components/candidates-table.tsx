"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Check, CheckCircle2, Download, Loader2, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { RecommendationBadge, SourceBadge, StageBadge, StatusBadge, isRetryingBusyAi } from "@/components/candidate/badges";
import { ScoreBadge } from "@/components/candidate/score-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import type { CandidateSource, CandidateStage, CandidateStatus } from "@/db/schema";
import type { Recommendation } from "@/lib/ai/schemas";
import { cn } from "@/lib/cn";
import { CANDIDATE_STAGE_LABELS, CANDIDATE_STATUS_LABELS } from "@/lib/format";
import { deleteCandidatesAction, rescoreAction, updateStageAction, type ReviewActionResult } from "../actions";
import { useAnnounce } from "./announcer";
import { downloadFile, saveBlob } from "./download";
import { useRestoreFocus } from "./use-restore-focus";
import { prepareCvZip, type ExportRequest } from "./zip-export";

/** Slim, serializable row — the page never ships cvText or full profiles to the client. */
export type CandidateRow = {
  id: string;
  /** Rank by score within the current view (job or stage), as exports number it; null while unscored. */
  rank: number | null;
  name: string;
  subline: string | null;
  status: CandidateStatus;
  error: string | null;
  score: number | null;
  recommendation: Recommendation | null;
  topSkills: string[];
  experienceYears: number | null;
  stage: CandidateStage;
  source: CandidateSource;
  /** Pre-formatted on the server so client and server render the same text. */
  added: string;
};

const ACTION_BATCH = 500;

type BulkAction = "shortlisted" | "rejected" | "new" | "rescore" | "rescore-all" | "delete";
type ExportFormat = "csv" | "xlsx" | "zip";

const EXPORT_BUTTONS: Array<{ format: ExportFormat; label: string; done: string }> = [
  { format: "csv", label: "CSV", done: "CSV export downloaded" },
  { format: "xlsx", label: "Excel", done: "Excel export downloaded" },
  { format: "zip", label: "ZIP of CVs", done: "ZIP of CVs downloaded" },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function outcomeMessage(action: BulkAction, count: number): string {
  if (count === 0) return "Nothing changed — those candidates may have been removed already.";
  const n = plural(count, "candidate");
  switch (action) {
    case "shortlisted":
    case "rejected":
      return `${n} ${CANDIDATE_STAGE_LABELS[action].toLowerCase()}`;
    case "new":
      return `${n} moved to ${CANDIDATE_STAGE_LABELS.new}`;
    case "rescore":
    case "rescore-all":
      return `Re-scoring ${n}`;
    case "delete":
      return `${n} deleted`;
  }
}

function failureMessage(action: BulkAction): string {
  if (action === "delete") return "Couldn't delete the candidates. Try again.";
  if (action === "rescore" || action === "rescore-all") return "Couldn't start re-scoring. Try again.";
  return "Couldn't update the candidates. Try again.";
}

async function inBatches(ids: string[], run: (batch: string[]) => Promise<ReviewActionResult>): Promise<ReviewActionResult> {
  let count = 0;
  for (let i = 0; i < ids.length; i += ACTION_BATCH) {
    const result = await run(ids.slice(i, i + ACTION_BATCH));
    if (!result.ok) return result;
    count += result.count;
  }
  return { ok: true, count };
}

export function CandidatesTable({
  jobId,
  rows,
  stage,
  totalInJob,
}: {
  jobId: string;
  rows: CandidateRow[];
  stage: CandidateStage | null;
  totalInJob: number;
}) {
  const announce = useAnnounce();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Result of the last bulk action, shown in the toolbar until the selection changes.
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rescore-all" | "delete" | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  // CVs fetched so far while the browser builds a ZIP; null until the manifest says how many there are.
  const [zipProgress, setZipProgress] = useState<{ done: number; total: number } | null>(null);
  // A finished export that left something out (CVs missing from a ZIP).
  const [exportWarning, setExportWarning] = useState<string | null>(null);
  const restoreFocus = useRestoreFocus();
  const ids = {
    selectAll: useId(),
    deleteTrigger: useId(),
    deleteText: useId(),
    rescoreAllTrigger: useId(),
    rescoreAllText: useId(),
  };

  // Rows can leave the list (stage change, deletion, refresh), so selection is always intersected with what's shown.
  const selectedIds = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && !allSelected;
  const activeAction = pending ? busy : null;
  const confirmingDelete = confirm === "delete" && selectedIds.length > 0;

  function changeSelection(next: Set<string>) {
    setSelected(next);
    setConfirm(null);
    setNotice(null);
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    changeSelection(next);
  }

  function toggleAll() {
    changeSelection(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function run(action: BulkAction, call: () => Promise<ReviewActionResult>) {
    setError(null);
    setExportWarning(null);
    setNotice(null);
    setBusy(action);
    startTransition(async () => {
      try {
        const result = await call();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const message = outcomeMessage(action, result.count);
        setSelected(new Set());
        setConfirm(null);
        setNotice(message);
        announce(message);
        // The toolbar swaps its buttons back, so the one that was clicked is gone.
        restoreFocus(ids.selectAll);
      } catch (err) {
        unstable_rethrow(err);
        setError(failureMessage(action));
      }
    });
  }

  function cancelConfirm() {
    const trigger = confirm === "delete" ? ids.deleteTrigger : ids.rescoreAllTrigger;
    setConfirm(null);
    restoreFocus(trigger);
  }

  const moveTo = (target: CandidateStage) => () =>
    run(target, () => inBatches(selectedIds, (batch) => updateStageAction(jobId, batch, target)));
  const rescoreSelected = () => run("rescore", () => inBatches(selectedIds, (batch) => rescoreAction(jobId, batch)));
  const rescoreAll = () => run("rescore-all", () => rescoreAction(jobId, "all"));
  const deleteSelected = () => run("delete", () => inBatches(selectedIds, (batch) => deleteCandidatesAction(jobId, batch)));

  // Exporting every visible row is the same as exporting the view, and needs no id list.
  const exportSelection = selectedIds.length > 0 && !allSelected;

  // The selection as it is now: a ZIP keeps fetching after the click, while the user may change the selection.
  const exportRequest: ExportRequest = (format) => {
    // The stage goes along with a selection too, so exported ranks match the ones on screen.
    const fields: Record<string, string> = stage ? { format, stage } : { format };
    return exportSelection
      ? // Intentional: POST for selections — hundreds of ids overflow URL length limits.
        [`/api/jobs/${jobId}/export`, { method: "POST", body: new URLSearchParams({ ...fields, ids: selectedIds.join(",") }) }]
      : [`/api/jobs/${jobId}/export?${new URLSearchParams(fields)}`];
  };

  async function exportAs(format: ExportFormat, done: string) {
    setError(null);
    setExportWarning(null);
    setExporting(format);
    if (format === "zip") {
      await exportZip(done);
      return;
    }
    const outcome = await downloadFile(...exportRequest(format), `candidates.${format}`);
    setExporting(null);
    if (outcome.ok) announce(done);
    else setError(outcome.sessionExpired ? outcome.error : `Couldn't export — ${outcome.error}`);
  }

  async function exportZip(done: string) {
    let announced = false;
    try {
      const result = await prepareCvZip(exportRequest, (fetched, total) => {
        setZipProgress({ done: fetched, total });
        if (!announced) {
          announced = true;
          announce(`Preparing a ZIP of ${plural(total, "CV")}…`);
        }
      });
      if (!result.ok) {
        setError(result.sessionExpired ? result.error : `Couldn't export — ${result.error}`);
        return;
      }
      saveBlob(result.blob, result.fileName);
      if (result.missing > 0) {
        const warning = `ZIP downloaded, but ${plural(result.missing, "CV")} of ${result.total} couldn't be included. They're listed in missing-files.txt inside the ZIP.`;
        setExportWarning(warning);
        announce(warning);
      } else {
        announce(done);
      }
    } catch {
      // JSZip failed to load (e.g. a deploy replaced the chunk) or ran out of memory building the archive.
      setError("Couldn't export — the ZIP couldn't be built. Try again, or export a stage or a selection.");
    } finally {
      setExporting(null);
      setZipProgress(null);
    }
  }

  const actionIcon = (action: BulkAction, Icon: typeof Check) =>
    activeAction === action ? <Loader2 className="animate-spin" aria-hidden /> : <Icon aria-hidden />;

  return (
    <div>
      <div
        role="toolbar"
        aria-label="Candidate actions"
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line px-4 py-3",
          confirmingDelete ? "bg-danger-soft/60" : selectedIds.length > 0 && "bg-brand-soft/40",
        )}
      >
        {confirmingDelete ? (
          <div role="group" aria-labelledby={ids.deleteText} className="flex flex-wrap items-center gap-2">
            <span id={ids.deleteText} className="mr-1 text-sm text-danger">
              Permanently delete {plural(selectedIds.length, "candidate")} and{" "}
              {selectedIds.length === 1 ? "their CV" : "their CVs"}? This can&apos;t be undone.
            </span>
            <Button variant="danger" size="sm" onClick={deleteSelected} disabled={pending}>
              {actionIcon("delete", Trash2)}
              Delete {plural(selectedIds.length, "candidate")}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelConfirm} disabled={pending} autoFocus>
              Cancel
            </Button>
          </div>
        ) : selectedIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-medium text-ink tabular-nums">{selectedIds.length} selected</span>
            <Button variant="secondary" size="sm" onClick={moveTo("shortlisted")} disabled={pending}>
              {actionIcon("shortlisted", Check)}
              Shortlist
            </Button>
            <Button variant="secondary" size="sm" onClick={moveTo("rejected")} disabled={pending}>
              {actionIcon("rejected", X)}
              Reject
            </Button>
            <Button variant="secondary" size="sm" onClick={moveTo("new")} disabled={pending}>
              {actionIcon("new", Undo2)}
              Move to New
            </Button>
            <Button variant="secondary" size="sm" onClick={rescoreSelected} disabled={pending}>
              {actionIcon("rescore", RefreshCw)}
              Re-score
            </Button>
            <Button
              id={ids.deleteTrigger}
              variant="danger"
              size="sm"
              onClick={() => {
                setError(null);
                setConfirm("delete");
              }}
              disabled={pending}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => changeSelection(new Set())} disabled={pending}>
              Clear selection
            </Button>
          </div>
        ) : confirm === "rescore-all" ? (
          <div role="group" aria-labelledby={ids.rescoreAllText} className="flex flex-wrap items-center gap-2">
            <span id={ids.rescoreAllText} className="text-sm text-ink">
              Re-run the AI ranking for all {totalInJob} candidates in this job?
            </span>
            <Button size="sm" onClick={rescoreAll} disabled={pending}>
              {actionIcon("rescore-all", RefreshCw)}
              Re-score all
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelConfirm} disabled={pending} autoFocus>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {notice ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-ink">
                <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                {notice}
              </span>
            ) : (
              <span className="text-sm text-ink-muted">Ranked by match score</span>
            )}
            <Button
              id={ids.rescoreAllTrigger}
              variant="ghost"
              size="sm"
              onClick={() => {
                setError(null);
                setNotice(null);
                setConfirm("rescore-all");
              }}
            >
              <RefreshCw aria-hidden />
              Re-score all
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">Export{exportSelection ? " selected" : ""}</span>
          {EXPORT_BUTTONS.map(({ format, label, done }) => (
            <Button
              key={format}
              variant="secondary"
              size="sm"
              onClick={() => exportAs(format, done)}
              disabled={exporting !== null}
            >
              {exporting === format ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
              {format === "zip" && exporting === "zip" ? (
                <span className="tabular-nums">
                  Preparing ZIP…{zipProgress && ` ${zipProgress.done} of ${zipProgress.total}`}
                </span>
              ) : (
                label
              )}
            </Button>
          ))}
        </div>
      </div>

      {(error || exportWarning) && (
        <div className="space-y-3 border-b border-line px-4 py-3">
          {error && <Alert tone="danger">{error}</Alert>}
          {exportWarning && <Alert tone="warning">{exportWarning}</Alert>}
        </div>
      )}

      <div className="relative overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Candidates ranked by match score</caption>
          <thead className="bg-subtle text-xs font-medium text-ink-muted">
            <tr>
              <th scope="col" className="w-10 py-2.5 pr-2 pl-4">
                <input
                  id={ids.selectAll}
                  type="checkbox"
                  aria-label="Select all candidates"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  className="size-4 cursor-pointer accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                />
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">
                #
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Candidate
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Score
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Fit
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Top skills
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium whitespace-nowrap">
                Experience
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Stage
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Source
              </th>
              <th scope="col" className="py-2.5 pr-4 pl-3 font-medium">
                Added
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const isSelected = selected.has(row.id);
              return (
                <tr
                  key={row.id}
                  className={cn("transition-colors", isSelected ? "bg-brand-soft/50" : "hover:bg-subtle/60")}
                >
                  <td className="py-3 pr-2 pl-4 align-middle">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.name}`}
                      checked={isSelected}
                      onChange={() => toggle(row.id)}
                      className="size-4 cursor-pointer accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    />
                  </td>
                  <td className="px-2 py-3 text-ink-muted tabular-nums">{row.rank === null ? "—" : `#${row.rank}`}</td>
                  <td className="px-3 py-3">
                    <div className="max-w-64 min-w-44">
                      <Link
                        href={`/dashboard/jobs/${jobId}/candidates/${row.id}`}
                        className="block truncate rounded-sm font-medium text-ink hover:text-brand-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                        title={row.name}
                      >
                        {row.name}
                      </Link>
                      {row.subline && (
                        <p className="truncate text-xs text-ink-muted" title={row.subline}>
                          {row.subline}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <ScoreCell row={row} />
                  </td>
                  <td className="px-3 py-3">
                    <RecommendationBadge recommendation={row.status === "ready" ? row.recommendation : null} />
                  </td>
                  <td className="px-3 py-3">
                    {row.topSkills.length > 0 ? (
                      <div className="flex max-w-60 flex-wrap gap-1">
                        {row.topSkills.map((skill) => (
                          <Badge key={skill} tone="neutral" className="max-w-40 truncate" title={skill}>
                            {skill}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-ink tabular-nums">
                    {row.experienceYears === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      `${row.experienceYears} ${row.experienceYears === 1 ? "yr" : "yrs"}`
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StageBadge stage={row.stage} />
                  </td>
                  <td className="px-3 py-3">
                    <SourceBadge source={row.source} compact />
                  </td>
                  <td className="py-3 pr-4 pl-3 whitespace-nowrap text-ink-muted tabular-nums">{row.added}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScoreCell({ row }: { row: CandidateRow }) {
  // A queued CV with a note is waiting for a busy AI service to recover, not being analyzed right now.
  if (isRetryingBusyAi(row.status, row.error)) return <StatusBadge status={row.status} error={row.error} />;
  if (row.status === "pending" || row.status === "processing") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-muted">
        <Loader2 className="size-4 animate-spin text-ink-faint" aria-hidden />
        {CANDIDATE_STATUS_LABELS.processing}
      </span>
    );
  }
  if (row.status === "failed") return <StatusBadge status="failed" error={row.error} />;
  return <ScoreBadge score={row.score} />;
}
