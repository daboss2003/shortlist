import Link from "next/link";
import { Loader2 } from "lucide-react";
import { ScoreBadge } from "@/components/candidate/score-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { JobWithStats } from "@/lib/data/jobs";
import { EMPLOYMENT_TYPE_LABELS, JOB_STATUS_LABELS, formatDate } from "@/lib/format";

const th = "px-4 py-2.5 text-xs font-medium whitespace-nowrap text-ink-muted";
const td = "px-4 py-3 align-top";

function Count({ value }: { value: number }) {
  return <span className={cn("tabular-nums", value === 0 ? "text-ink-faint" : "text-ink")}>{value}</span>;
}

export function JobsTable({ jobs }: { jobs: JobWithStats[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-3xl text-sm">
          <caption className="sr-only">Jobs, newest first</caption>
          <thead className="border-b border-line bg-subtle">
            <tr>
              <th scope="col" className={cn(th, "text-left")}>Job</th>
              <th scope="col" className={cn(th, "text-left")}>Status</th>
              <th scope="col" className={cn(th, "text-right")}>Candidates</th>
              <th scope="col" className={cn(th, "text-right")}>Ranked</th>
              <th scope="col" className={cn(th, "text-right")}>Shortlisted</th>
              <th scope="col" className={cn(th, "text-right")}>Top score</th>
              <th scope="col" className={cn(th, "text-right")}>Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {jobs.map((job) => {
              const meta = [job.location, job.employmentType && EMPLOYMENT_TYPE_LABELS[job.employmentType]]
                .filter(Boolean)
                .join(" · ");
              return (
                <tr key={job.id} className="transition-colors hover:bg-subtle/60">
                  <td className={td}>
                    <div className="max-w-sm min-w-48">
                      <Link
                        href={`/dashboard/jobs/${job.id}`}
                        className="rounded-sm font-medium text-ink hover:text-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                      >
                        {job.title}
                      </Link>
                      {meta && <p className="mt-0.5 truncate text-xs text-ink-muted">{meta}</p>}
                    </div>
                  </td>
                  <td className={td}>
                    <Badge tone={job.status === "open" ? "success" : "neutral"}>{JOB_STATUS_LABELS[job.status]}</Badge>
                  </td>
                  <td className={cn(td, "text-right")}>
                    <Count value={job.candidateCount} />
                  </td>
                  <td className={cn(td, "text-right")}>
                    <Count value={job.readyCount} />
                    {job.pendingCount > 0 && (
                      <p className="mt-0.5 flex items-center justify-end gap-1 text-xs whitespace-nowrap text-ink-muted">
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                        {job.pendingCount} analyzing
                      </p>
                    )}
                  </td>
                  <td className={cn(td, "text-right")}>
                    <Count value={job.shortlistedCount} />
                  </td>
                  <td className={cn(td, "text-right")}>
                    <ScoreBadge score={job.topScore} />
                  </td>
                  <td className={cn(td, "text-right whitespace-nowrap text-ink-muted")}>{formatDate(job.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
