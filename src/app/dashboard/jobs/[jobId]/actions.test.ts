import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import type { Employer } from "@/lib/auth/dal";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../../../test/factories";

const mocks = vi.hoisted(() => ({
  employer: null as Employer | null,
  schedule: vi.fn(),
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

const { deleteCandidateAction, rescoreAction, updateStageAction } = await import("./actions");

const employerFor = (companyId: string): Employer => ({
  userId: "u",
  name: "Owner",
  email: "owner@example.com",
  companyId,
  companyName: "Acme",
  companyWebsite: null,
});

async function setup() {
  const a = makeCompany();
  const b = makeCompany();
  const job = makeJob(a.company.id);
  const foreignJob = makeJob(b.company.id);
  const cv = await validateCvUpload(new File([new Uint8Array(Buffer.from("%PDF-1.4\n"))], "cv.pdf"));
  const mine = await createCandidateFromCv({ job, source: "upload", cv });
  const theirs = await createCandidateFromCv({ job: foreignJob, source: "upload", cv });
  mocks.employer = employerFor(a.company.id);
  return { job, foreignJob, mine, theirs };
}

const row = (id: string) => db.select().from(candidates).where(eq(candidates.id, id)).get();

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
    expect(row(mine.id)?.stage).toBe("shortlisted");
    expect(row(theirs.id)?.stage).toBe("new");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("rejects malformed input without touching the database", async () => {
    const { job, mine } = await setup();
    expect(await updateStageAction(job.id, ["not-a-uuid"], "shortlisted")).toMatchObject({ ok: false });
    expect(await updateStageAction(job.id, [mine.id], "hired" as never)).toMatchObject({ ok: false });
    expect(await updateStageAction(job.id, [], "rejected")).toMatchObject({ ok: false });
    const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect(await updateStageAction(job.id, tooMany, "rejected")).toMatchObject({ ok: false });
    expect(row(mine.id)?.stage).toBe("new");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("rescoreAction", () => {
  it("re-queues own candidates and schedules exactly those ids", async () => {
    const { job, mine, theirs } = await setup();
    db.update(candidates).set({ status: "failed", error: "boom" }).run();

    expect(await rescoreAction(job.id, [mine.id, theirs.id])).toEqual({ ok: true, count: 1 });

    expect(row(mine.id)).toMatchObject({ status: "pending", error: null });
    expect(row(theirs.id)).toMatchObject({ status: "failed", error: "boom" });
    expect(mocks.schedule).toHaveBeenCalledWith([mine.id]);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("supports 'all' and does not schedule when nothing was re-queued", async () => {
    const { foreignJob } = await setup();
    expect(await rescoreAction(foreignJob.id, "all")).toEqual({ ok: true, count: 0 });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe("deleteCandidateAction", () => {
  it("deletes an own candidate and redirects to the job page", async () => {
    const { job, mine } = await setup();
    await expect(deleteCandidateAction(job.id, mine.id)).rejects.toThrow(`REDIRECT:/dashboard/jobs/${job.id}`);
    expect(row(mine.id)).toBeUndefined();
  });

  it("leaves another company's candidate untouched", async () => {
    const { job, theirs } = await setup();
    expect(await deleteCandidateAction(job.id, theirs.id)).toMatchObject({ ok: false });
    expect(row(theirs.id)).toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
