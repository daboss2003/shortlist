"use server";

import type { JobStatus } from "@/db/schema";

// CONTRACT (frozen) — implemented by the employer-jobs workstream, which owns this file and may
// add more actions (createJob, updateJob, …). The candidate-review workstream imports setJobStatus.

/** Opens/closes a job owned by the signed-in employer's company. No-op (notFound) for foreign ids. */
export async function setJobStatus(jobId: string, status: JobStatus): Promise<void> {
  void jobId;
  void status;
  throw new Error("not implemented");
}
