import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Alert, LoadingBlock } from "@/components/ui/feedback";
import { requireEmployer } from "@/lib/auth/dal";
import { getJobForCompany } from "@/lib/data/jobs";
import { countJobCandidates } from "@/lib/jobs/service";
import { DeleteJobCard } from "../../../_components/delete-job-card";
import { PageHeader } from "../../../_components/page-header";
import { deleteJobAction, updateJobAction } from "../../actions";
import { JobForm } from "../../job-form";

export const metadata: Metadata = { title: "Edit job" };

export default function EditJobPage(props: PageProps<"/dashboard/jobs/[jobId]/edit">) {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <EditJob {...props} />
    </Suspense>
  );
}

async function EditJob({ params }: PageProps<"/dashboard/jobs/[jobId]/edit">) {
  const { companyId } = await requireEmployer();
  const { jobId } = await params;
  const job = await getJobForCompany(companyId, jobId);
  if (!job) notFound();
  const candidateCount = await countJobCandidates(companyId, job.id);
  const jobHref = `/dashboard/jobs/${job.id}`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader back={{ href: jobHref, label: job.title }} title="Edit job" />
      {candidateCount > 0 && (
        <Alert tone="info">Saving doesn&apos;t re-score existing candidates — use Re-score all on the job page.</Alert>
      )}
      <JobForm
        // Intentional: remount whenever the job changes. Cache Components keeps this page mounted (React Activity),
        // and after a save React resets the uncontrolled fields to the defaults they were mounted with — the old
        // job — so a second edit would silently send the first edit's stale values back.
        key={job.updatedAt.getTime()}
        action={updateJobAction.bind(null, job.id)}
        defaults={{
          title: job.title,
          department: job.department ?? "",
          location: job.location ?? "",
          employmentType: job.employmentType ?? "",
          description: job.description,
          requirements: job.requirements,
          skills: job.skills.join(", "),
          minExperienceYears: job.minExperienceYears?.toString() ?? "",
        }}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        cancelHref={jobHref}
      />
      <DeleteJobCard
        jobTitle={job.title}
        candidateCount={candidateCount}
        deleteAction={deleteJobAction.bind(null, job.id)}
      />
    </div>
  );
}
