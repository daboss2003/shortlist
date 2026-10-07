import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import type { Employer } from "@/lib/auth/dal";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../../../test/factories";

const mocks = vi.hoisted(() => ({
  employer: null as Employer | null,
  schedule: vi.fn(async () => {}),
  refresh: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireEmployer: async () => {
    if (!mocks.employer) throw new Error("REDIRECT:/login");
    return mocks.employer;
  },
  getCurrentEmployer: async () => mocks.employer,
}));
vi.mock("@/lib/pipeline", () => ({ scheduleCandidateProcessing: mocks.schedule }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const { deleteCandidateAction, deleteCandidatesAction, rescoreAction, updateStageAction } = await import("./actions");

const employerFor = (companyId: string): Employer => ({
  userId: "u",
  name: "Owner",
  email: "owner@example.com",
  companyId,
  companyName: "Acme",
  companyWebsite: null,
});

async function setup() {
  const a = await makeCompany();
  const b = await makeCompany();
  const job = await makeJob(a.company.id);
  const foreignJob = await makeJob(b.company.id);
  const cv = await validateCvUpload(new File([new Uint8Array(Buffer.from("%PDF-1.4\n"))], "cv.pdf"));
  const mine = await createCandidateFromCv({ job, source: "upload", cv });
  const theirs = await createCandidateFromCv({ job: foreignJob, source: "upload", cv });
  mocks.employer = employerFor(a.company.id);
  return { job, foreignJob, mine, theirs };
}

const row = async (id: string) => (await db.select().from(candidates).where(eq(candidates.id, id)))[0];

beforeEach(() => {
  mocks.employer = null;
  mocks.schedule.mockReset();
  mocks.refresh.mockReset();
  mocks.redirect.mockClear();
});

describe("updateStageAction", () => {
  it("requires a signed-in employer", async () => {
    await expect(updateStageAction(crypto.randomUUID(), [crypto.randomUUID()], "shortlisted")).rejects.toThrow(
      "REDIRECT:/login",
    );
  });

  it("updates own candidates, ignores foreign ids and refreshes", async () => {
    const { job, mine, theirs } = await setup();
    expect(await updateStageAction(job.id, [mine.id, theirs.id], "shortlisted")).toEqual({ ok: true, count: 1 });
    expect((await row(mine.id))?.stage).toBe("shortlisted");
    expect((await row(theirs.id))?.stage).toBe("new");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("rejects malformed input without touching the database", async () => {
    const { job, mine } = await setup();
    expect(await updateStageAction(job.id, ["not-a-uuid"], "shortlisted")).toMatchObject({ ok: false });
    expect(await updateStageAction(job.id, [mine.id], "hired" as never)).toMatchObject({ ok: false });
    expect(await updateStageAction(job.id, [], "rejected")).toMatchObject({ ok: false });
    const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect(await updateStageAction(job.id, tooMany, "rejected")).toMatchObject({ ok: false });
    expect((await row(mine.id))?.stage).toBe("new");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("rescoreAction", () => {
  it("re-queues own candidates and schedules exactly those ids", async () => {
    const { job, mine, theirs } = await setup();
    await db.update(candidates).set({ status: "failed", error: "boom" });

    expect(await rescoreAction(job.id, [mine.id, theirs.id])).toEqual({ ok: true, count: 1 });

    expect(await row(mine.id)).toMatchObject({ status: "pending", error: null });
    expect(await row(theirs.id)).toMatchObject({ status: "failed", error: "boom" });
    expect(mocks.schedule).toHaveBeenCalledWith([mine.id]);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("supports 'all' and does not schedule when nothing was re-queued", async () => {
    const { foreignJob } = await setup();
    expect(await rescoreAction(foreignJob.id, "all")).toEqual({ ok: true, count: 0 });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("counts and schedules a candidate that is mid-analysis", async () => {
    const { job, mine } = await setup();
    await db.update(candidates).set({ status: "processing" }).where(eq(candidates.id, mine.id));

    expect(await rescoreAction(job.id, "all")).toEqual({ ok: true, count: 1 });
    expect((await row(mine.id))?.status).toBe("pending");
    expect(mocks.schedule).toHaveBeenCalledWith([mine.id]);
  });
});

describe("deleteCandidatesAction", () => {
  it("requires a signed-in employer", async () => {
    await expect(deleteCandidatesAction(crypto.randomUUID(), [crypto.randomUUID()])).rejects.toThrow("REDIRECT:/login");
  });

  it("deletes own candidates and their CVs, ignores foreign ids and refreshes", async () => {
    const { job, mine, theirs } = await setup();
    const cv = await validateCvUpload(new File([new Uint8Array(Buffer.from("%PDF-1.4\n% second\n"))], "b.pdf"));
    const second = await createCandidateFromCv({ job, source: "upload", cv });

    expect(await deleteCandidatesAction(job.id, [mine.id, second.id, theirs.id])).toEqual({ ok: true, count: 2 });

    expect(await row(mine.id)).toBeUndefined();
    expect(await row(second.id)).toBeUndefined();
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR!, mine.cvFileKey))).toBe(false);
    expect(await row(theirs.id)).toBeDefined();
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR!, theirs.cvFileKey))).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("can't reach another company's job", async () => {
    const { foreignJob, theirs } = await setup();
    expect(await deleteCandidatesAction(foreignJob.id, [theirs.id])).toEqual({ ok: true, count: 0 });
    expect(await row(theirs.id)).toBeDefined();
  });

  it("rejects malformed input without touching the database", async () => {
    const { job, mine } = await setup();
    expect(await deleteCandidatesAction(job.id, ["not-a-uuid"])).toMatchObject({ ok: false });
    expect(await deleteCandidatesAction(job.id, [])).toMatchObject({ ok: false });
    expect(await deleteCandidatesAction("not-a-uuid", [mine.id])).toMatchObject({ ok: false });
    const tooMany = [mine.id, ...Array.from({ length: 500 }, () => crypto.randomUUID())];
    expect(await deleteCandidatesAction(job.id, tooMany)).toMatchObject({ ok: false });
    expect(await row(mine.id)).toBeDefined();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("deleteCandidateAction", () => {
  it("deletes an own candidate and redirects to the job page", async () => {
    const { job, mine } = await setup();
    await expect(deleteCandidateAction(job.id, mine.id)).rejects.toThrow(`REDIRECT:/dashboard/jobs/${job.id}`);
    expect(await row(mine.id)).toBeUndefined();
  });

  it("leaves another company's candidate untouched", async () => {
    const { job, theirs } = await setup();
    expect(await deleteCandidateAction(job.id, theirs.id)).toMatchObject({ ok: false });
    expect(await row(theirs.id)).toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
