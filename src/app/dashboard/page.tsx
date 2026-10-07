import type { Metadata } from "next";
import { Suspense } from "react";
import { Briefcase, Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, LoadingBlock } from "@/components/ui/feedback";
import { getAiQuota } from "@/lib/ai/quota";
import { getAiStatus } from "@/lib/ai/status";
import { requireEmployer } from "@/lib/auth/dal";
import { listJobsWithStats } from "@/lib/data/jobs";
import { AiStatusNotice, AiUsageNote } from "./_components/ai-status-notice";
import { JobsTable } from "./_components/jobs-table";
import { PageHeader } from "./_components/page-header";

export const metadata: Metadata = { title: "Jobs" };

export default function JobsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
        description="Each job has its own application link. Candidates are ranked against the role as their CVs arrive."
        actions={
          <ButtonLink href="/dashboard/jobs/new">
            <Plus aria-hidden />
            New job
          </ButtonLink>
        }
      />
      <Suspense fallback={<LoadingBlock label="Loading jobs…" />}>
        <JobsContent />
      </Suspense>
    </div>
  );
}

async function JobsContent() {
  const { companyId, isPlatformAdmin } = await requireEmployer();
  const jobs = listJobsWithStats(companyId);
  const ai = getAiStatus();
  const quota = getAiQuota(companyId);

  return (
    <div className="space-y-6">
      <AiStatusNotice status={ai} quota={quota} showOperatorDetails={isPlatformAdmin === true} />
      {jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Briefcase aria-hidden />}
            title="No jobs yet"
            description="Create a job to get a shareable application link. Every CV that comes in is analyzed and ranked against the role."
            action={
              <ButtonLink href="/dashboard/jobs/new">
                <Plus aria-hidden />
                Create your first job
              </ButtonLink>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          <JobsTable jobs={jobs} />
          <AiUsageNote status={ai} quota={quota} />
        </div>
      )}
    </div>
  );
}
