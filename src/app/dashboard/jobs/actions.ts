"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { JOB_STATUSES, type Job, type JobStatus } from "@/db/schema";
import { requireEmployer } from "@/lib/auth/dal";
import { getJobForCompany } from "@/lib/data/jobs";
import * as jobService from "@/lib/jobs/service";
import type { JobField, JobFieldErrors } from "@/lib/jobs/service";

// The candidate-review workstream imports setJobStatus (frozen contract). Every action re-checks auth and
// takes the company from the session; ids sent by the client are only ever looked up within that company.

export type JobFormState = {
  fieldErrors?: JobFieldErrors;
  /** Echoed back so the form keeps what was typed (React resets forms after an action). */
  values?: Partial<Record<JobField, string>>;
};

const FIELDS: JobField[] = [
  "title",
  "department",
  "location",
  "employmentType",
  "description",
  "requirements",
  "skills",
  "minExperienceYears",
];

function readJobForm(formData: FormData): Record<JobField, string> {
  return Object.fromEntries(
    FIELDS.map((field) => {
      const v = formData.get(field);
      return [field, typeof v === "string" ? v : ""];
    }),
  ) as Record<JobField, string>;
}

/** Tenant check shared by every action that targets an existing job: missing or foreign → 404. */
async function requireOwnJob(jobId: unknown): Promise<{ companyId: string; job: Job }> {
  const { companyId } = await requireEmployer();
  const job = typeof jobId === "string" ? await getJobForCompany(companyId, jobId) : null;
  if (!job) notFound();
  return { companyId, job };
}

/**
 * revalidatePath re-renders the current page in the action's response (like refresh()) and marks every
 * other dashboard page stale, so the jobs list is fresh on the next visit. The public apply page shows
 * the job's details and open/closed state, so it is revalidated too.
 */
function revalidateJobViews(job: Pick<Job, "slug">) {
  revalidatePath("/dashboard", "layout");
  revalidatePath(`/apply/${job.slug}`);
}

export async function createJobAction(_prev: JobFormState, formData: FormData): Promise<JobFormState> {
  const { companyId } = await requireEmployer();
  const values = readJobForm(formData);
  const parsed = jobService.parseJobInput(values);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors, values };

  const job = await jobService.createJob(companyId, parsed.data);
  revalidateJobViews(job);
  redirect(`/dashboard/jobs/${job.id}`);
}

export async function updateJobAction(jobId: string, _prev: JobFormState, formData: FormData): Promise<JobFormState> {
  const { companyId, job } = await requireOwnJob(jobId);
  const values = readJobForm(formData);
  const parsed = jobService.parseJobInput(values);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors, values };

  if (!(await jobService.updateJob(companyId, job.id, parsed.data))) notFound();
  revalidateJobViews(job);
  redirect(`/dashboard/jobs/${job.id}`);
}

export async function deleteJobAction(jobId: string): Promise<void> {
  const { companyId, job } = await requireOwnJob(jobId);
  const result = await jobService.deleteJob(companyId, job.id);
  if (result === "not-found") notFound();
  // An incomplete delete still removed some candidates.
  revalidateJobViews(job);
  if (result === "incomplete") {
    // Intentional: thrown, not returned — the delete form has no error state, so the dashboard error boundary
    // ("Something went wrong", Try again) shows it. The job is kept, and deleting it again finishes the job.
    throw new Error("Some of this job's CV files couldn't be deleted, so the job was kept. Try again.");
  }
  redirect("/dashboard");
}

/** Opens/closes a job owned by the signed-in employer's company. No-op (notFound) for foreign ids. */
export async function setJobStatus(jobId: string, status: JobStatus): Promise<void> {
  const { companyId, job } = await requireOwnJob(jobId);
  const parsed = z.enum(JOB_STATUSES).safeParse(status);
  if (!parsed.success) throw new Error("Invalid job status");

  if (!(await jobService.setJobStatus(companyId, job.id, parsed.data))) notFound();
  revalidateJobViews(job);
}
