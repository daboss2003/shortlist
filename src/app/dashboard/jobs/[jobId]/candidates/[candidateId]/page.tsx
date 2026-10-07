import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Globe, Loader2, Mail, MapPin, Phone } from "lucide-react";
import { SourceBadge, StageBadge, StatusBadge } from "@/components/candidate/badges";
import { Card } from "@/components/ui/card";
import { Alert, EmptyState, LoadingBlock } from "@/components/ui/feedback";
import { getCurrentEmployer, requireEmployer } from "@/lib/auth/dal";
import { candidateDisplayName } from "@/lib/candidates/review";
import { getCandidateForCompany } from "@/lib/data/candidates";
import { aiProviderLabel, formatBytes, formatDate } from "@/lib/format";
import { Announcer } from "../../_components/announcer";
import { AutoRefresh } from "../../_components/auto-refresh";
import { CandidateActions, RetryAnalysisButton } from "./candidate-actions";
import { EvaluationCard } from "./evaluation-card";
import { ProfileCard, QualificationsCard } from "./profile-cards";

type Props = PageProps<"/dashboard/jobs/[jobId]/candidates/[candidateId]">;

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ jobId, candidateId }, employer] = await Promise.all([props.params, getCurrentEmployer()]);
  const candidate = employer ? getCandidateForCompany(employer.companyId, candidateId) : null;
  return { title: candidate && candidate.jobId === jobId ? candidateDisplayName(candidate) : "Candidate" };
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <CandidateDetail {...props} />
    </Suspense>
  );
}

async function CandidateDetail({ params }: Props) {
  const employer = await requireEmployer();
  const { jobId, candidateId } = await params;
  const candidate = getCandidateForCompany(employer.companyId, candidateId);
  if (!candidate || candidate.jobId !== jobId) notFound();

  const { job, profile, evaluation, status } = candidate;
  const analyzing = status === "pending" || status === "processing";
  const name = candidateDisplayName(candidate);
  const headline = profile?.headline?.trim();
  const email = candidate.email ?? profile?.email ?? null;
  const phone = candidate.phone ?? profile?.phone ?? null;
  const links = profileLinks(profile?.links ?? []);

  return (
    <Announcer>
      <div className="space-y-6">
        <div className="space-y-3">
          <Link
            href={`/dashboard/jobs/${job.id}`}
            className="inline-flex max-w-full items-center gap-1 rounded-sm text-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{job.title}</span>
          </Link>
          <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h1 className="text-2xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{name}</h1>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StageBadge stage={candidate.stage} />
                  <SourceBadge source={candidate.source} />
                  {status !== "ready" && <StatusBadge status={status} error={candidate.error} />}
                </div>
              </div>
              {headline && <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">{headline}</p>}
              <ContactRow email={email} phone={phone} location={profile?.location ?? null} links={links} />
            </div>
            <CandidateActions
              jobId={job.id}
              candidateId={candidate.id}
              cvFileName={candidate.cvFileName}
              stage={candidate.stage}
              status={status}
            />
          </header>
        </div>

        {analyzing && (
          <Alert tone="info" title="Analyzing this CV — this usually takes under a minute.">
            {evaluation
              ? "The results below are from the previous analysis. This page updates on its own."
              : "This page updates on its own."}
          </Alert>
        )}
        {status === "failed" && (
          <Alert
            tone="danger"
            title="We couldn't analyze this CV"
            action={<RetryAnalysisButton jobId={job.id} candidateId={candidate.id} />}
          >
            {candidate.error ?? "Something went wrong while reading or ranking this CV."}
          </Alert>
        )}

        {evaluation || profile ? (
          <div className="grid items-start gap-6 lg:grid-cols-3">
            <div className="min-w-0 space-y-6 lg:col-span-2">
              {evaluation && <EvaluationCard evaluation={evaluation} score={candidate.score} />}
              {profile && <ProfileCard profile={profile} />}
            </div>
            {profile && (
              <div className="min-w-0">
                <QualificationsCard profile={profile} />
              </div>
            )}
          </div>
        ) : (
          <Card>
            {analyzing ? (
              <EmptyState
                icon={<Loader2 className="animate-spin" aria-hidden />}
                title="Building the candidate profile"
                description="The match score, strengths and work history appear here once the CV has been analyzed."
              />
            ) : (
              <EmptyState
                icon={<FileText aria-hidden />}
                title="No profile yet"
                description="Download the CV to review it yourself, or try the analysis again."
              />
            )}
          </Card>
        )}

        <footer className="flex flex-col gap-1 border-t border-line pt-4 text-xs text-ink-muted sm:flex-row sm:flex-wrap sm:justify-between sm:gap-x-6">
          {candidate.aiProvider && (
            <p>
              Ranked by {aiProviderLabel(candidate.aiProvider)}
              {candidate.aiModel && ` · ${candidate.aiModel}`}
              {candidate.processedAt && ` · ${formatDate(candidate.processedAt)}`}
            </p>
          )}
          <p className="[overflow-wrap:anywhere]">
            CV: {candidate.cvFileName} ({formatBytes(candidate.cvSize)}) · Added {formatDate(candidate.createdAt)}
          </p>
        </footer>

        <AutoRefresh active={analyzing} />
      </div>
    </Announcer>
  );
}

type ProfileLink = { href: string; label: string } | { href: null; label: string };

/** Only http(s) URLs become links; bare domains ("github.com/jane") are treated as https. */
function profileLinks(raw: string[]): ProfileLink[] {
  const seen = new Set<string>();
  const out: ProfileLink[] = [];
  for (const value of raw) {
    const text = value.trim();
    if (!text) continue;
    const withScheme = /^[a-z][a-z\d+.-]*:/i.test(text)
      ? text
      : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)
        ? `https://${text}`
        : null;
    let url: URL | null = null;
    try {
      url = withScheme ? new URL(withScheme) : null;
    } catch {
      url = null;
    }
    if (url && (url.protocol === "http:" || url.protocol === "https:")) {
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
      out.push({ href: url.href, label: `${url.hostname.replace(/^www\./, "")}${path}` });
    } else if (!seen.has(text)) {
      seen.add(text);
      out.push({ href: null, label: text });
    }
  }
  return out;
}

const EMAIL_PATTERN = /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+$/;

function ContactRow({
  email,
  phone,
  location,
  links,
}: {
  email: string | null;
  phone: string | null;
  location: string | null;
  links: ProfileLink[];
}) {
  const items: Array<{ key: string; icon: ReactNode; content: ReactNode }> = [];
  const linkCls =
    "rounded-sm text-ink-muted hover:text-brand-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

  if (email) {
    items.push({
      key: "email",
      icon: <Mail />,
      content: EMAIL_PATTERN.test(email) ? (
        <a href={`mailto:${email}`} className={linkCls}>
          {email}
        </a>
      ) : (
        email
      ),
    });
  }
  if (phone) {
    const dial = phone.replace(/[^\d+]/g, "");
    items.push({
      key: "phone",
      icon: <Phone />,
      content:
        dial.length >= 6 ? (
          <a href={`tel:${dial}`} className={linkCls}>
            {phone}
          </a>
        ) : (
          phone
        ),
    });
  }
  if (location) items.push({ key: "location", icon: <MapPin />, content: location });
  links.forEach((link, i) => {
    items.push({
      key: `link-${i}`,
      icon: <Globe />,
      content: link.href ? (
        <a href={link.href} target="_blank" rel="noopener noreferrer nofollow" className={linkCls}>
          {link.label}
        </a>
      ) : (
        link.label
      ),
    });
  });

  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-muted">
      {items.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-faint">
          <span aria-hidden className="flex">{item.icon}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{item.content}</span>
        </li>
      ))}
    </ul>
  );
}
