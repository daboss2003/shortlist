import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui/feedback";
import { requireEmployer } from "@/lib/auth/dal";
import { newestJobId } from "@/lib/jobs/service";
import { PageHeader } from "../../_components/page-header";
import { createJobAction } from "../actions";
import { JobForm } from "../job-form";

export const metadata: Metadata = { title: "New job" };

export default function NewJobPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: "/dashboard", label: "Jobs" }}
        title="New job"
        description="You'll get a shareable application link as soon as the job is created."
      />
      <Suspense fallback={<LoadingBlock />}>
        <NewJobForm />
      </Suspense>
    </div>
  );
}

async function NewJobForm() {
  const { companyId } = await requireEmployer();
  const newestId = await newestJobId(companyId);
  return (
    <JobForm
      // Intentional: a fresh form after each job is created. Cache Components keeps this page mounted (React
      // Activity), so the last attempt's errors and echoed values would otherwise greet the next visit. Keyed on
      // the newest job rather than per request so an unsaved draft survives navigating away and back.
      key={newestId ?? "first"}
      action={createJobAction}
      submitLabel="Create job"
      pendingLabel="Creating…"
      cancelHref="/dashboard"
    />
  );
}
