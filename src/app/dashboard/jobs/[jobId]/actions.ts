"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { CANDIDATE_STAGES, type CandidateStage } from "@/db/schema";
import { requireEmployer } from "@/lib/auth/dal";
import { deleteCandidate, deleteCandidates, markForRescore, setCandidatesStage } from "@/lib/candidates/review";
import { scheduleCandidateProcessing } from "@/lib/pipeline";

export type ReviewActionResult = { ok: true; count: number } | { ok: false; error: string };

const MAX_IDS = 500;
const idSchema = z.uuid();
const idsSchema = z.array(z.uuid()).min(1).max(MAX_IDS);

const stageInput = z.object({ jobId: idSchema, ids: idsSchema, stage: z.enum(CANDIDATE_STAGES) });
const rescoreInput = z.object({ jobId: idSchema, ids: z.union([z.literal("all"), idsSchema]) });
const deleteInput = z.object({ jobId: idSchema, candidateId: idSchema });
const bulkDeleteInput = z.object({ jobId: idSchema, ids: idsSchema });

const INVALID: ReviewActionResult = { ok: false, error: "That request wasn't valid. Reload the page and try again." };

export async function updateStageAction(
  jobId: string,
  ids: string[],
  stage: CandidateStage,
): Promise<ReviewActionResult> {
  const employer = await requireEmployer();
  const input = stageInput.safeParse({ jobId, ids, stage });
  if (!input.success) return INVALID;

  const count = setCandidatesStage(employer.companyId, input.data.jobId, input.data.ids, input.data.stage);
  refresh();
  return { ok: true, count };
}

export async function rescoreAction(jobId: string, ids: string[] | "all"): Promise<ReviewActionResult> {
  const employer = await requireEmployer();
  const input = rescoreInput.safeParse({ jobId, ids });
  if (!input.success) return INVALID;

  const queued = markForRescore(employer.companyId, input.data.jobId, input.data.ids);
  if (queued.length > 0) scheduleCandidateProcessing(queued);
  refresh();
  return { ok: true, count: queued.length };
}

/** Permanently deletes candidates of this job and their CVs. Foreign ids are ignored (not counted). */
export async function deleteCandidatesAction(jobId: string, ids: string[]): Promise<ReviewActionResult> {
  const employer = await requireEmployer();
  const input = bulkDeleteInput.safeParse({ jobId, ids });
  if (!input.success) return INVALID;

  const count = await deleteCandidates(employer.companyId, input.data.jobId, input.data.ids);
  refresh();
  return { ok: true, count };
}

/** Deletes the candidate and their CV, then redirects to the job page. */
export async function deleteCandidateAction(jobId: string, candidateId: string): Promise<ReviewActionResult> {
  const employer = await requireEmployer();
  const input = deleteInput.safeParse({ jobId, candidateId });
  if (!input.success) return INVALID;

  const deleted = await deleteCandidate(employer.companyId, input.data.candidateId);
  if (!deleted) return { ok: false, error: "This candidate no longer exists." };
  redirect(`/dashboard/jobs/${input.data.jobId}`);
}
