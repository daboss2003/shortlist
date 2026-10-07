import { describe, expect, it } from "vitest";
import { GENERIC_FAILURE_MESSAGE, runProcessCvSteps } from "@/lib/pipeline/steps";
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

  it("fails a CV still processing once process-cv runs out of retries, and leaves a finished one alone", async () => {
    const stuck = await makeCandidate();
    const finished = await makeCandidate();
    await setRow(stuck.id, { status: "processing" });
    await setRow(finished.id, { status: "ready" });
    const onFailure = processCv.opts.onFailure!;
    const step = { run: (_id: string, fn: () => Promise<unknown>) => fn() };
    const failureFor = (candidateId: string) =>
      ({ event: { data: { event: { data: { candidateId, companyId: "co" } } } }, step }) as unknown as Parameters<
        typeof onFailure
      >[0];

    await onFailure(failureFor(stuck.id));
    await onFailure(failureFor(finished.id));

    expect(await reload(stuck.id)).toMatchObject({ status: "failed", error: GENERIC_FAILURE_MESSAGE });
    expect((await reload(finished.id)).status).toBe("ready");
  });

  it("hands Inngest a failed step's database error without the query's data (here, the CV text)", async () => {
    const c = await makeCandidate({ text: `${CV_TEXT}\nSECRET-MARKER private reference` });
    const inline = { run: (_id: string, fn: () => Promise<unknown>) => fn() };
    const restore = await rejectCvTextWrites();
    let err: Error;
    try {
      err = (await runProcessCvSteps(c.id, durableSteps(inline), [providerWith("gemini", workingModel())]).catch(
        (e: unknown) => e,
      )) as Error;
    } finally {
      await restore();
    }

    expect(err.message).toMatch(/^database query failed: .*cv text rejected by test trigger/);
    expect(`${err.message}\n${err.stack}`).not.toContain("SECRET-MARKER");
  });
});
