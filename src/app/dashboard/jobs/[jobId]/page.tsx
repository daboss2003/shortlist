import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Inbox, Lock, Pencil, Sparkles, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, EmptyState, LoadingBlock } from "@/components/ui/feedback";
import { CANDIDATE_STAGES, type Candidate, type CandidateStage } from "@/db/schema";
import { getAiStatus, type AiStatus } from "@/lib/ai/status";
import { getCurrentEmployer, requireEmployer } from "@/lib/auth/dal";
import { candidateDisplayName } from "@/lib/candidates/review";
import { cn } from "@/lib/cn";
import { listCandidatesForJob } from "@/lib/data/candidates";
import { getJobForCompany } from "@/lib/data/jobs";
import { CANDIDATE_STAGE_LABELS, EMPLOYMENT_TYPE_LABELS, JOB_STATUS_LABELS, formatDate } from "@/lib/format";
import { AutoRefresh } from "./_components/auto-refresh";
import { CandidatesTable, type CandidateRow } from "./_components/candidates-table";
import { JobStatusToggle, UploadCvsButton } from "./_components/job-header-actions";
import { ShareLink } from "./_components/share-link";
import { UploadCvsCard } from "./_components/upload-cvs";

export async function generateMetadata(props: PageProps<"/dashboard/jobs/[jobId]">): Promise<Metadata> {
  const [{ jobId }, employer] = await Promise.all([props.params, getCurrentEmployer()]);
  const job = employer ? getJobForCompany(employer.companyId, jobId) : null;
  return { title: job?.title ?? "Job" };
}

export default function Page(props: PageProps<"/dashboard/jobs/[jobId]">) {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <JobDetail {...props} />
    </Suspense>
  );
}

const EMPTY_STAGE_COPY: Record<CandidateStage, string> = {
  new: "New applications and uploaded CVs appear here until you shortlist or reject them.",
  shortlisted: "Candidates you shortlist appear here.",
  rejected: "Candidates you reject appear here.",
};

async function JobDetail({ params, searchParams }: PageProps<"/dashboard/jobs/[jobId]">) {
  const employer = await requireEmployer();
  const [{ jobId }, query] = await Promise.all([params, searchParams]);
  const job = getJobForCompany(employer.companyId, jobId);
  if (!job) notFound();

  const stage = parseStage(query.stage);
  const candidates = listCandidatesForJob(employer.companyId, job.id);
  const visible = stage ? candidates.filter((c) => c.stage === stage) : candidates;
  const analyzing = candidates.some((c) => c.status === "pending" || c.status === "processing");
  const ai = getAiStatus();

  const meta = [
    job.location,
    job.employmentType && EMPLOYMENT_TYPE_LABELS[job.employmentType],
    job.department,
    `Created ${formatDate(job.createdAt)}`,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 rounded-sm text-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Jobs
        </Link>
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{job.title}</h1>
              <Badge tone={job.status === "open" ? "success" : "neutral"}>{JOB_STATUS_LABELS[job.status]}</Badge>
            </div>
            <p className="text-sm text-ink-muted">{meta.join(" · ")}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <ButtonLink href={`/dashboard/jobs/${job.id}/edit`} variant="secondary">
              <Pencil aria-hidden />
              Edit job
            </ButtonLink>
            <JobStatusToggle jobId={job.id} status={job.status} />
            <UploadCvsButton />
          </div>
        </header>
      </div>

      <AiStatusAlert status={ai} />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Application link"
            description="Share it anywhere. Applicants upload their CV and are ranked against this job automatically."
          />
          <CardBody className="space-y-3">
            <ShareLink slug={job.slug} />
            {job.status === "closed" && (
              <p className="flex items-center gap-2 text-sm text-ink-muted">
                <Lock className="size-4 shrink-0" aria-hidden />
                Applications are closed — the link shows a closed notice.
              </p>
            )}
          </CardBody>
        </Card>
        <UploadCvsCard jobId={job.id} />
      </div>

      <section aria-labelledby="candidates-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="candidates-heading" className="text-base font-semibold text-ink">
            Candidates <span className="font-normal text-ink-muted tabular-nums">{candidates.length}</span>
          </h2>
          <AiRankingLine status={ai} />
        </div>

        {candidates.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Users aria-hidden />}
              title="No candidates yet"
              description="Share the application link or upload CVs you already have."
              action={<UploadCvsButton variant="secondary" />}
            />
          </Card>
        ) : (
          <>
            <StageTabs jobId={job.id} active={stage} candidates={candidates} />
            <Card className="overflow-hidden">
              {visible.length === 0 && stage ? (
                <EmptyState
                  icon={<Inbox aria-hidden />}
                  title={`No ${CANDIDATE_STAGE_LABELS[stage].toLowerCase()} candidates`}
                  description={EMPTY_STAGE_COPY[stage]}
                />
              ) : (
                <CandidatesTable
                  key={stage ?? "all"}
                  jobId={job.id}
                  rows={visible.map(toRow)}
                  stage={stage}
                  totalInJob={candidates.length}
                />
              )}
            </Card>
          </>
        )}
      </section>

      <AutoRefresh active={analyzing} />
    </div>
  );
}

function parseStage(value: string | string[] | undefined): CandidateStage | null {
  return typeof value === "string" && (CANDIDATE_STAGES as readonly string[]).includes(value)
    ? (value as CandidateStage)
    : null;
}

function toRow(c: Candidate, index: number): CandidateRow {
  const years = c.profile?.totalExperienceYears;
  return {
    id: c.id,
    // listCandidatesForJob ranks scored rows first, so the index is the rank within this filter.
    rank: c.score === null ? null : index + 1,
    name: candidateDisplayName(c),
    subline: c.profile?.headline?.trim() || c.email || null,
    status: c.status,
    error: c.error,
    score: c.score,
    recommendation: c.evaluation?.recommendation ?? null,
    topSkills: c.evaluation?.matchedSkills.slice(0, 3) ?? [],
    experienceYears: typeof years === "number" && Number.isFinite(years) ? Math.round(years * 10) / 10 : null,
    stage: c.stage,
    source: c.source,
    added: formatDate(c.createdAt),
  };
}

function StageTabs({ jobId, active, candidates }: { jobId: string; active: CandidateStage | null; candidates: Candidate[] }) {
  const tabs = [
    { stage: null, label: "All", count: candidates.length },
    ...CANDIDATE_STAGES.map((s) => ({
      stage: s,
      label: CANDIDATE_STAGE_LABELS[s],
      count: candidates.filter((c) => c.stage === s).length,
    })),
  ];

  return (
    <nav aria-label="Filter candidates by stage" className="relative flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => {
        const isActive = tab.stage === active;
        return (
          <Link
            key={tab.label}
            href={tab.stage ? `/dashboard/jobs/${jobId}?stage=${tab.stage}` : `/dashboard/jobs/${jobId}`}
            scroll={false}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand",
              isActive ? "border-brand text-ink" : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {tab.label}
            <span
              className={cn(
                "rounded-full px-1.5 text-xs tabular-nums",
                isActive ? "bg-brand-soft text-brand-ink" : "bg-subtle text-ink-muted",
              )}
            >
              {tab.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function AiStatusAlert({ status }: { status: AiStatus }) {
  if (!status.primary) {
    return (
      <Alert tone="warning" title="No AI provider configured">
        CVs will wait in the queue. Add GEMINI_API_KEY (or another provider key) and restart.
        {status.error && <span className="mt-1 block">{status.error}</span>}
      </Alert>
    );
  }
  if (status.error) {
    return (
      <Alert tone="warning" title="Check the AI configuration">
        {status.error}
      </Alert>
    );
  }
  return null;
}

function AiRankingLine({ status }: { status: AiStatus }) {
  if (!status.primary) return null;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-muted">
      <Sparkles className="size-4 shrink-0 text-ink-faint" aria-hidden />
      <span className="truncate">
        Ranking with {status.primary.label} · {status.primary.modelId}
      </span>
    </p>
  );
}

