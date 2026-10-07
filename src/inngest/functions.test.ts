import { describe, expect, it } from "vitest";
import { GENERIC_FAILURE_MESSAGE, claimStep, runProcessCvSteps } from "@/lib/pipeline/steps";
import {
  CV_TEXT,
  makeCandidate,
  providerWith,
  rejectCvTextWrites,
  reload,
  setRow,
  workingModel,
} from "@/lib/pipeline/test-helpers";
import { CV_PROCESS_REQUESTED } from "./client";
import { durableSteps, functions, processCv, requeuePending, retentionPurge } from "./functions";

const onFailure = processCv.opts.onFailure!;

/** Runs onFailure's steps inline, recording what each returned (Inngest stores it). */
function failureOf(candidateId: string, failedRunId: string) {
  const results: unknown[] = [];
  const step = {
    run: async (_id: string, fn: () => Promise<unknown>) => {
      const result = await fn();
      results.push(result);
      return result;
    },
  };
  const args = {
    event: {
      data: {
        function_id: "cv-review-pipeline-process-cv",
        run_id: failedRunId,
        error: { name: "Error", message: "database query failed" },
        event: { name: CV_PROCESS_REQUESTED, data: { candidateId, companyId: "co" } },
      },
    },
    step,
  } as unknown as Parameters<typeof onFailure>[0];
  return { args, results };
}

describe("Inngest functions", () => {
  it("serves the CV pipeline and both crons", () => {
    expect(functions.map((fn) => fn.id())).toEqual(["process-cv", "requeue-pending", "retention-purge"]);
    expect(requeuePending.opts.triggers).toEqual([{ cron: "*/30 * * * *" }]);
    expect(retentionPurge.opts.triggers).toEqual([{ cron: "0 * * * *" }]);
  });

  it("runs process-cv per CV event, fair per company, one run per CV, with retries", () => {
    const { triggers, concurrency, singleton, retries } = processCv.opts;
    expect(triggers).toMatchObject([{ event: CV_PROCESS_REQUESTED }]);
    expect(concurrency).toEqual([{ key: "event.data.companyId", limit: 2 }]);
    expect(singleton).toEqual({ key: "event.data.candidateId", mode: "cancel" });
    expect(retries).toBe(3);
  });

  it("fails a CV still held by the run that ran out of retries, and leaves a finished one alone", async () => {
    const stuck = await makeCandidate();
    const finished = await makeCandidate();
    await claimStep(stuck.id, "run-1");
    await claimStep(finished.id, "run-1");
    await setRow(finished.id, { status: "ready" });

    const failed = failureOf(stuck.id, "run-1");
    await onFailure(failed.args);
    await onFailure(failureOf(finished.id, "run-1").args);

    expect(await reload(stuck.id)).toMatchObject({ status: "failed", error: GENERIC_FAILURE_MESSAGE });
    expect((await reload(finished.id)).status).toBe("ready");
    // Inngest stores the step's result: a boolean, nothing about the candidate.
    expect(failed.results).toEqual([true]);
  });

  it("doesn't let an older run's failure fail the CV a newer run has claimed since", async () => {
    const c = await makeCandidate();
    await claimStep(c.id, "run-1");
    // A re-score or the re-queue started run 2, which took the row over; then run 1 ran out of retries.
    await claimStep(c.id, "run-2");

    await onFailure(failureOf(c.id, "run-1").args);
    expect(await reload(c.id)).toMatchObject({ status: "processing", error: null, claimToken: "run-2" });

    await onFailure(failureOf(c.id, "run-2").args);
    expect(await reload(c.id)).toMatchObject({ status: "failed", error: GENERIC_FAILURE_MESSAGE });
  });

  it("hands Inngest a failed step's database error without the query's data (here, the CV text)", async () => {
    const c = await makeCandidate({ text: `${CV_TEXT}\nSECRET-MARKER private reference` });
    const inline = { run: (_id: string, fn: () => Promise<unknown>) => fn() };
    const restore = await rejectCvTextWrites();
    let err: Error;
    try {
      err = (await runProcessCvSteps(c.id, "run-1", durableSteps(inline), [providerWith("gemini", workingModel())]).catch(
        (e: unknown) => e,
      )) as Error;
    } finally {
      await restore();
    }

    expect(err.message).toMatch(/^database query failed: .*cv text rejected by test trigger/);
    expect(`${err.message}\n${err.stack}`).not.toContain("SECRET-MARKER");
  });
});
