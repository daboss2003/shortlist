import "server-only";
import { cron } from "inngest";
import { cvProcessRequested, inngest } from "@/inngest/client";
import { withSafeErrors } from "@/lib/log";
import { requeuePendingCandidates } from "@/lib/pipeline";
import { GENERIC_FAILURE_MESSAGE, markFailed, runProcessCvSteps, type StepRunner } from "@/lib/pipeline/steps";
import { purgeExpiredRateLimits } from "@/lib/rate-limit";
import { purgeExpiredCandidateData } from "@/lib/retention";

// Inngest functions, served by src/app/api/inngest/route.ts. Every step is its own HTTP invocation of that route
// (checkpointing is off, see ./client), so each must finish inside Netlify's 60 s. The step bodies are plain
// functions in src/lib/pipeline/steps.ts, tested without the Inngest runtime.
// Inngest stores every step's result and error, beyond the reach of our retention deletes, so nothing personal may
// reach either: steps return codes and booleans only (the analysis is saved inside its own step), event data holds
// ids only, and everything that can throw runs inside withSafeErrors (a database error's message carries the
// query's data).

/**
 * Claim → extract → reserve quota → analyze and save (one step per model of the chain, falling back in order), for one
 * CV. When every model was only busy, a last step puts the CV back to pending for the requeue-pending cron.
 */
export const processCv = inngest.createFunction(
  {
    id: "process-cv",
    triggers: [cvProcessRequested],
    // At most 2 running steps per company, so one company's bulk upload can't take all of the free plan's 5
    // concurrent steps and hold up every other company's CVs.
    concurrency: [{ key: "event.data.companyId", limit: 2 }],
    // Intentional: a newer request for the same CV (a re-score) cancels the older run, so a run that is analyzing
    // against a job description the employer has since edited can't save over the new result. The claim step then
    // takes over the row the cancelled run left "processing", and the new claim token shuts out any write the
    // cancelled run's in-flight step still makes.
    singleton: { key: "event.data.candidateId", mode: "cancel" },
    retries: 3,
    // Every retry of a step failed (storage or database down, the function killed at its time limit…): the CV is
    // failed with a retry hint instead of staying "processing" forever. Only while the failed run still holds the
    // claim (its run id is the claim token): a newer run may own the row by now.
    onFailure: async ({ event, step }) => {
      const { candidateId } = event.data.event.data;
      const failedRunId = event.data.run_id;
      await step.run("mark-failed", () =>
        withSafeErrors(() => markFailed(candidateId, failedRunId, GENERIC_FAILURE_MESSAGE)),
      );
    },
  },
  async ({ event, step, runId }) => runProcessCvSteps(event.data.candidateId, runId, durableSteps(step)),
);

/**
 * Every 30 minutes: re-sends CVs still pending (lost events, caps that reset at midnight UTC, a provider added) and
 * CVs stuck "processing" since a claim over 30 minutes old (a run lost to an outage).
 */
export const requeuePending = inngest.createFunction(
  { id: "requeue-pending", triggers: [cron("*/30 * * * *")], concurrency: 1 },
  () => withSafeErrors(async () => ({ sent: await requeuePendingCandidates() })),
);

/** Hourly: candidate data past its retention period, and expired rate-limit counters. One batch per run. */
export const retentionPurge = inngest.createFunction(
  { id: "retention-purge", triggers: [cron("0 * * * *")], concurrency: 1 },
  () =>
    withSafeErrors(async () => ({
      candidatesDeleted: await purgeExpiredCandidateData(),
      rateLimitsDeleted: await purgeExpiredRateLimits(),
    })),
);

export const functions = [processCv, requeuePending, retentionPurge];

/** Adapts Inngest's `step` to the pipeline's StepRunner. */
export function durableSteps(step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> }): StepRunner {
  return {
    // Intentional: the cast is sound because every step result is plain JSON (strings, numbers, booleans, null,
    // arrays and objects of those), which Inngest's serialization round-trips unchanged.
    run: <T>(id: string, fn: () => Promise<T>) => step.run(id, () => withSafeErrors(fn)) as Promise<T>,
  };
}
