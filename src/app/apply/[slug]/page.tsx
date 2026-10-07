import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense, cache, type ReactNode } from "react";
import { Award, Briefcase, Building2, Calendar, CircleSlash, ExternalLink, MapPin, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { getPublicJobBySlug, type PublicJob } from "@/lib/data/jobs";
import { EMPLOYMENT_TYPE_LABELS, formatDate } from "@/lib/format";
import { ApplicationForm } from "./_components/application-form";
import { PoweredByFooter } from "./_components/powered-by-footer";

const container = "mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8";

// generateMetadata and the page both read the job in the same request.
const getJob = cache(getPublicJobBySlug);

export async function generateMetadata(props: PageProps<"/apply/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const job = getJob(slug);
  // Intentional: job links are unlisted (shared by the employer), so search engines must not index them.
  const robots = { index: false, follow: false };
  if (!job) return { title: { absolute: "Job not found" }, robots };

  const title = `${job.title} at ${job.companyName}`;
  const description = excerpt(job.description);
  return { title: { absolute: title }, description, robots, openGraph: { title, description } };
}

export default function Page(props: PageProps<"/apply/[slug]">) {
  return (
    <div className="flex flex-1 flex-col bg-canvas">
      <Suspense fallback={<ApplySkeleton />}>
        <ApplyContent params={props.params} />
      </Suspense>
      <PoweredByFooter />
    </div>
  );
}

async function ApplyContent({ params }: Pick<PageProps<"/apply/[slug]">, "params">) {
  const { slug } = await params;
  const job = getJob(slug);
  if (!job) notFound();

  const isOpen = job.status === "open";
  const website = httpUrl(job.companyWebsite);

  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className={cn(container, "flex h-16 items-center justify-between gap-4")}>
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-base font-semibold text-brand-ink"
            >
              {monogram(job.companyName)}
            </span>
            <span className="truncate text-base font-semibold text-ink">{job.companyName}</span>
          </div>
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={buttonClass("ghost", "sm", "shrink-0")}
            >
              Visit website
              <ExternalLink aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </div>
      </header>

      <main className={cn(container, "flex-1 py-8 sm:py-12")}>
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            {isOpen ? `${job.companyName} is hiring` : job.companyName}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance wrap-break-word text-ink">
            {job.title}
          </h1>
          <JobFacts job={job} />
          {isOpen && (
            <a href="#apply" className={buttonClass("primary", "lg", "mt-6 w-full sm:w-auto lg:hidden")}>
              Apply now
            </a>
          )}
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-5 lg:items-start lg:gap-8">
          <Card className="min-w-0 divide-y divide-line lg:col-span-3">
            <JobSection title="About the role">
              <p className="whitespace-pre-line">{job.description}</p>
            </JobSection>
            {job.requirements.trim() && (
              <JobSection title="Requirements">
                <p className="whitespace-pre-line">{job.requirements}</p>
              </JobSection>
            )}
            {job.skills.length > 0 && (
              <JobSection title="Key skills">
                <ul className="flex flex-wrap gap-2">
                  {job.skills.map((skill, i) => (
                    <li key={`${i}-${skill}`} className="max-w-full">
                      <Badge className="max-w-full" title={skill}>
                        <span className="truncate">{skill}</span>
                      </Badge>
                    </li>
                  ))}
                </ul>
              </JobSection>
            )}
          </Card>

          {/* Intentional: sticky only when the viewport is tall enough to show the whole form, so the submit
              button is never stranded below the fold on short laptop screens. */}
          <Card
            id="apply"
            className={cn(
              "min-w-0 scroll-mt-6 lg:top-6 lg:col-span-2 lg:[@media(min-height:50rem)]:sticky",
              !isOpen && "order-first lg:order-0",
            )}
          >
            {isOpen ? (
              <ApplicationForm slug={job.slug} companyName={job.companyName} jobTitle={job.title} />
            ) : (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-subtle text-ink-muted">
                  <CircleSlash className="size-6" aria-hidden />
                </span>
                <h2 className="mt-4 text-base font-semibold text-ink">
                  This role is no longer accepting applications.
                </h2>
                <p className="mt-1 text-sm text-ink-muted">Thanks for your interest in {job.companyName}.</p>
              </div>
            )}
          </Card>
        </div>
      </main>
    </>
  );
}

function JobFacts({ job }: { job: PublicJob }) {
  const facts: { label: string; value: string; Icon: LucideIcon }[] = [];
  if (job.location) facts.push({ label: "Location", value: job.location, Icon: MapPin });
  if (job.employmentType) {
    facts.push({ label: "Employment type", value: EMPLOYMENT_TYPE_LABELS[job.employmentType], Icon: Briefcase });
  }
  if (job.department) facts.push({ label: "Department", value: job.department, Icon: Building2 });
  if (job.minExperienceYears) {
    const years = job.minExperienceYears;
    facts.push({ label: "Experience", value: `${years}+ year${years === 1 ? "" : "s"} experience`, Icon: Award });
  }
  facts.push({ label: "Date posted", value: `Posted ${formatDate(job.createdAt)}`, Icon: Calendar });

  return (
    <ul className="mt-4 flex flex-wrap gap-2">
      {facts.map(({ label, value, Icon }) => (
        <li
          key={label}
          className="inline-flex max-w-full items-start gap-1.5 rounded-md bg-surface px-2.5 py-1 text-sm leading-5 text-ink-muted ring-1 ring-line ring-inset"
        >
          <Icon className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
          <span className="sr-only">{label}: </span>
          <span className="min-w-0 wrap-break-word">{value}</span>
        </li>
      ))}
    </ul>
  );
}

function JobSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-5 py-6 sm:px-8">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <div className="mt-3 text-base leading-7 wrap-break-word text-ink-muted">{children}</div>
    </section>
  );
}

function ApplySkeleton() {
  const pulse = "rounded-md motion-safe:animate-pulse";
  return (
    <div className="flex flex-1 flex-col" aria-busy="true">
      <p className="sr-only" role="status">
        Loading job details…
      </p>
      <div className="border-b border-line bg-surface">
        <div className={cn(container, "flex h-16 items-center gap-3")}>
          <div className={cn(pulse, "size-9 rounded-lg bg-subtle")} />
          <div className={cn(pulse, "h-4 w-32 bg-subtle")} />
        </div>
      </div>
      <div className={cn(container, "flex-1 py-8 sm:py-12")}>
        <div className={cn(pulse, "h-3 w-28 bg-line")} />
        <div className={cn(pulse, "mt-3 h-8 w-full max-w-md bg-line")} />
        <div className="mt-4 flex flex-wrap gap-2">
          {["w-24", "w-20", "w-28", "w-32"].map((w) => (
            <div key={w} className={cn(pulse, "h-7 bg-line", w)} />
          ))}
        </div>
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-5 lg:items-start lg:gap-8">
          <div className="rounded-xl border border-line bg-surface px-5 py-6 shadow-xs sm:px-8 lg:col-span-3">
            <div className={cn(pulse, "h-4 w-32 bg-subtle")} />
            <div className="mt-4 space-y-3">
              {["w-full", "w-full", "w-11/12", "w-full", "w-2/3"].map((w, i) => (
                <div key={i} className={cn(pulse, "h-3.5 bg-subtle", w)} />
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface px-5 py-5 shadow-xs lg:col-span-2">
            <div className={cn(pulse, "h-4 w-36 bg-subtle")} />
            <div className="mt-6 space-y-5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <div className={cn(pulse, "h-3 w-20 bg-subtle")} />
                  <div className={cn(pulse, "h-10 w-full rounded-lg bg-subtle")} />
                </div>
              ))}
              <div className={cn(pulse, "h-28 w-full rounded-lg bg-subtle")} />
              <div className={cn(pulse, "h-11 w-full rounded-lg bg-subtle")} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function monogram(companyName: string): string {
  return Array.from(companyName.trim())[0]?.toUpperCase() ?? "?";
}

/** Only http(s) links are rendered: the stored website is employer-entered text. */
function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function excerpt(text: string, max = 150): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
