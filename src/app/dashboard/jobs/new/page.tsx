import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui/feedback";
import { requireEmployer } from "@/lib/auth/dal";
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
  await requireEmployer();
  return <JobForm action={createJobAction} submitLabel="Create job" pendingLabel="Creating…" cancelHref="/dashboard" />;
}
