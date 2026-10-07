import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates, jobs } from "@/db/schema";
import type { Employer } from "@/lib/auth/dal";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import * as storage from "@/lib/storage";
import { makeCompany, makeJob } from "../../../../test/factories";

const mocks = vi.hoisted(() => ({ employer: null as Employer | null, revalidatePath: vi.fn() }));

vi.mock("@/lib/auth/dal", () => ({
  requireEmployer: async () => {
    if (!mocks.employer) throw new Error("REDIRECT:/login");
    return mocks.employer;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const { createJobAction, deleteJobAction, updateJobAction } = await import("./actions");

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const jobForm = (overrides: Record<string, string> = {}) =>
  form({ title: "Backend Engineer", description: "Build our APIs.", employmentType: "full_time", ...overrides });
const jobRow = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];
const candidateCount = async (jobId: string) =>
  (await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.jobId, jobId))).length;

async function signIn() {
  const { company, user } = await makeCompany();
  mocks.employer = {
    userId: user.id,
    name: user.name,
    email: user.email,
    companyId: company.id,
    companyName: company.name,
    companyWebsite: null,
    isPlatformAdmin: false,
  };
  return company;
}

async function addCandidate(job: { id: string; companyId: string }) {
  const cv = await validateCvUpload(new File([`%PDF-1.4 ${crypto.randomUUID()}`], "cv.pdf"));
  return createCandidateFromCv({ job, source: "upload", cv });
}

beforeEach(() => {
  mocks.employer = null;
  mocks.revalidatePath.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createJobAction / updateJobAction with a NUL character", () => {
  it("returns field errors instead of throwing, and writes nothing", async () => {
    const company = await signIn();
    const state = await createJobAction({}, jobForm({ title: "Back\u0000end", description: "APIs\u0000" }));
    expect(state.fieldErrors).toEqual({
      title: "Contains an invalid character.",
      description: "Contains an invalid character.",
    });
    expect(state.values?.title).toBe("Back\u0000end");
    expect(await db.select().from(jobs).where(eq(jobs.companyId, company.id))).toEqual([]);
  });

  it("leaves an existing job untouched", async () => {
    const company = await signIn();
    const job = await makeJob(company.id);
    const state = await updateJobAction(job.id, {}, jobForm({ location: "Lagos\u0000" }));
    expect(state.fieldErrors).toEqual({ location: "Contains an invalid character." });
    expect((await jobRow(job.id)).location).toBeNull();
  });

  it("treats a job id with a NUL character as missing", async () => {
    await signIn();
    await expect(updateJobAction(`${crypto.randomUUID()}\u0000`, {}, jobForm())).rejects.toThrow("NOT_FOUND");
    await expect(deleteJobAction(`${crypto.randomUUID()}\u0000`)).rejects.toThrow("NOT_FOUND");
  });
});

describe("deleteJobAction", () => {
  it("deletes the job and redirects to the dashboard", async () => {
    const company = await signIn();
    const job = await makeJob(company.id);
    await addCandidate(job);

    await expect(deleteJobAction(job.id)).rejects.toThrow("REDIRECT:/dashboard");
    expect(await jobRow(job.id)).toBeUndefined();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
  });

  it("404s another company's job and leaves it alone", async () => {
    const other = (await makeCompany()).company;
    const job = await makeJob(other.id);
    await signIn();
    await expect(deleteJobAction(job.id)).rejects.toThrow("NOT_FOUND");
    expect(await jobRow(job.id)).toBeDefined();
  });

  it("keeps the job and throws for the error boundary when a CV file can't be deleted", async () => {
    const company = await signIn();
    const job = await makeJob(company.id);
    const stuck = await addCandidate(job);
    const gone = await addCandidate(job);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const realDelete = storage.deleteCvFile;
    vi.spyOn(storage, "deleteCvFile").mockImplementation(async (key) => {
      if (key === stuck.cvFileKey) throw new Error("Blobs unavailable");
      return realDelete(key);
    });

    await expect(deleteJobAction(job.id)).rejects.toThrow(
      "Some of this job's CV files couldn't be deleted, so the job was kept. Try again.",
    );
    expect(await jobRow(job.id)).toBeDefined();
    expect(await candidateCount(job.id)).toBe(1);
    expect(await storage.cvFileExists(stuck.cvFileKey)).toBe(true);
    expect(await storage.cvFileExists(gone.cvFileKey)).toBe(false);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
  });
});
