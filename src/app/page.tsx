import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, Check, FileUp, Link2, ListOrdered } from "lucide-react";
import { ScoreBadge } from "@/components/candidate/score-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { CandidateStage } from "@/db/schema";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { APP_NAME } from "@/lib/brand";
import { CANDIDATE_STAGE_LABELS, EMPLOYMENT_TYPE_LABELS } from "@/lib/format";
import { Wordmark } from "./dashboard/_components/wordmark";

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} — Share one link. Get every CV ranked against the role.` },
};

const container = "mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8";

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line bg-surface">
        <div className={`${container} flex h-16 items-center justify-between gap-4`}>
          <Wordmark href="/" />
          <Suspense fallback={<SignedOutActions />}>
            <HeaderActions />
          </Suspense>
        </div>
      </header>

      <main className="flex-1">
        <Hero />
        <HowItWorks />
        <Profiles />
        <ClosingCta />
      </main>

      <footer className="border-t border-line bg-surface">
        <div className={`${container} flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between`}>
          <div className="space-y-2">
            <Wordmark href="/" />
            <p className="text-sm text-ink-muted">AI-ranked CV screening for hiring teams.</p>
          </div>
          <nav aria-label="Footer" className="flex gap-6 text-sm">
            <Link href="/login" className={footerLink}>
              Log in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

const footerLink =
  "rounded-sm text-ink-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

async function HeaderActions() {
  const employer = await getCurrentEmployer();
  if (!employer) return <SignedOutActions />;
  return (
    <ButtonLink href="/dashboard" size="sm">
      Go to dashboard
      <ArrowRight aria-hidden />
    </ButtonLink>
  );
}

function SignedOutActions() {
  return (
    <ButtonLink href="/login" variant="secondary" size="sm">
      Log in
    </ButtonLink>
  );
}

const INVITE_NOTE = "Have an invite? Use the link you were sent.";

function Hero() {
  return (
    <section className={`${container} grid gap-12 py-16 sm:py-20 lg:grid-cols-2 lg:items-center lg:gap-16 lg:py-24`}>
      <div>
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">CV screening for hiring teams</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance text-ink sm:text-5xl">
          Share one link. Get every CV ranked against the role.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-pretty text-ink-muted">
          Post a job, share its application link and let AI read every CV that comes in. Each candidate gets a
          structured profile and a match score with the reasons behind it, so you start with the strongest applicants.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <ButtonLink href="/login" size="lg">
            Log in
            <ArrowRight aria-hidden />
          </ButtonLink>
          <ButtonLink href="#how-it-works" variant="secondary" size="lg">
            See how it works
          </ButtonLink>
        </div>
        <p className="mt-3 text-sm text-ink-muted">Accounts are by invitation. {INVITE_NOTE}</p>
        <ul className="mt-8 grid gap-2 text-sm text-ink-muted sm:grid-cols-2">
          {[
            "PDF, Word and plain-text CVs",
            "Strengths and gaps behind every score",
            "Upload CVs you already have",
            "Export to CSV, Excel or a ZIP of CVs",
          ].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className="size-4 shrink-0 text-success" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      </div>
      <ProductPreview />
    </section>
  );
}

const SAMPLE_CANDIDATES: {
  name: string;
  headline: string;
  years: number;
  skills: string[];
  score: number;
  stage: CandidateStage;
}[] = [
  { name: "Adaeze Okafor", headline: "Senior Software Engineer, Payments", years: 8, skills: ["Node.js", "PostgreSQL", "AWS"], score: 92, stage: "shortlisted" },
  { name: "Tomás Herrera", headline: "Backend Developer", years: 6, skills: ["Node.js", "TypeScript"], score: 84, stage: "shortlisted" },
  { name: "Priya Raman", headline: "Full-stack Engineer", years: 5, skills: ["TypeScript", "AWS"], score: 76, stage: "new" },
  { name: "Daniel Mensah", headline: "Software Engineer", years: 3, skills: ["Node.js"], score: 61, stage: "new" },
  { name: "Sofia Lindqvist", headline: "Frontend Engineer", years: 4, skills: ["TypeScript"], score: 38, stage: "new" },
];

function ProductPreview() {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-ink">Senior Backend Engineer</p>
          <p className="mt-0.5 truncate text-sm text-ink-muted">
            Lagos, Nigeria · Hybrid · {EMPLOYMENT_TYPE_LABELS.full_time} · 48 candidates
          </p>
        </div>
        <Badge>Example</Badge>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Example of a ranked candidate list, using sample data</caption>
          <thead className="border-b border-line bg-subtle text-xs font-medium text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-2 text-left font-medium">Candidate</th>
              <th scope="col" className="hidden px-4 py-2 text-left font-medium md:table-cell">Matched skills</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Match</th>
              <th scope="col" className="hidden px-4 py-2 text-left font-medium sm:table-cell">Stage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {SAMPLE_CANDIDATES.map((c) => (
              <tr key={c.name}>
                <td className="w-full max-w-0 px-4 py-3">
                  <p className="truncate font-medium text-ink">{c.name}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {c.headline} · {c.years} yrs
                  </p>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {c.skills.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <ScoreBadge score={c.score} />
                </td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  <Badge tone={c.stage === "shortlisted" ? "brand" : "neutral"}>{CANDIDATE_STAGE_LABELS[c.stage]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STEPS = [
  {
    Icon: Link2,
    title: "Post a job and share its link",
    body: "Describe the role, its requirements and the skills that matter. You get a public application page to share on your careers page, job boards or social posts.",
  },
  {
    Icon: FileUp,
    title: "Collect CVs",
    body: "Applicants upload their CV in a minute, with no account needed. Already have a pile of CVs from email or a recruiter? Upload them yourself.",
  },
  {
    Icon: ListOrdered,
    title: "Review a ranked shortlist",
    body: "AI extracts every profile and ranks candidates against your requirements. Export the ones you want as CSV, Excel or a ZIP of CVs.",
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-8 border-y border-line bg-surface">
      <div className={`${container} py-16 sm:py-20`}>
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">How it works</h2>
          <p className="mt-2 text-base text-ink-muted">From job post to shortlist in three steps.</p>
        </div>
        <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
          {STEPS.map(({ Icon, title, body }, i) => (
            <li key={title}>
              <div className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
                <Icon className="size-5" aria-hidden />
              </div>
              <p className="mt-5 text-xs font-medium tracking-wide text-ink-muted uppercase">Step {i + 1}</p>
              <h3 className="mt-1 text-base font-semibold text-ink">{title}</h3>
              <p className="mt-2 text-base text-pretty text-ink-muted">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const PROFILE_FIELDS = [
  "Work history, with titles, companies and dates",
  "Total years of experience",
  "Education, certifications and languages",
  "Skills matched and missing against the role",
  "Strengths and concerns, each backed by the CV",
  "Portfolio, GitHub and LinkedIn links",
];

function Profiles() {
  return (
    <section className={`${container} grid gap-10 py-16 sm:py-20 lg:grid-cols-2 lg:gap-16`}>
      <div className="max-w-xl">
        <h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Every CV becomes a profile you can compare</h2>
        <p className="mt-3 text-base text-pretty text-ink-muted">
          No more opening attachments one by one. Each CV is read once, turned into the same structured profile and
          scored against the job you described. You decide who to shortlist; the score tells you where to look first.
        </p>
      </div>
      <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:self-center">
        {PROFILE_FIELDS.map((item) => (
          <li key={item} className="flex gap-3 text-base text-ink">
            <Check className="mt-1 size-4 shrink-0 text-brand" aria-hidden />
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className={`${container} pb-16 sm:pb-20`}>
      <Card className="flex flex-col gap-6 px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-10">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-ink">Ready to fill your next role?</h2>
          <p className="mt-1 text-base text-ink-muted">
            {INVITE_NOTE} You can post your first job and share its link in a few minutes.
          </p>
        </div>
        <ButtonLink href="/login" size="lg" className="shrink-0">
          Log in
          <ArrowRight aria-hidden />
        </ButtonLink>
      </Card>
    </section>
  );
}
