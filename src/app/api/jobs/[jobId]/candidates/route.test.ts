import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import type { Employer } from "@/lib/auth/dal";
import { makeCompany, makeJob } from "../../../../../../test/factories";

const mocks = vi.hoisted(() => ({
  employer: null as Employer | null,
  schedule: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  getCurrentEmployer: async () => mocks.employer,
  requireEmployer: async () => mocks.employer,
}));
vi.mock("@/lib/pipeline", () => ({ scheduleCandidateProcessing: mocks.schedule }));

const { POST } = await import("./route");

function employerFor(companyId: string): Employer {
  return { userId: "u", name: "Owner", email: "owner@example.com", companyId, companyName: "Acme", companyWebsite: null };
}

const pdf = (name: string) => new File([new Uint8Array(Buffer.from("%PDF-1.4\n% test\n"))], name, { type: "application/pdf" });
const exe = (name: string) => new File([new Uint8Array(Buffer.from("MZ\x90\x00binary"))], name);

function upload(jobId: string, files: File[], origin = "http://localhost") {
  const body = new FormData();
  for (const f of files) body.append("files", f);
  const request = new Request(`http://localhost/api/jobs/${jobId}/candidates`, {
    method: "POST",
    body,
    headers: { origin, host: "localhost" },
  });
  return POST(request, { params: Promise.resolve({ jobId }) });
}

beforeEach(() => {
  mocks.employer = null;
  mocks.schedule.mockReset();
});

describe("POST /api/jobs/[jobId]/candidates", () => {
  it("returns 401 when signed out", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const res = await upload(job.id, [pdf("a.pdf")]);
    expect(res.status).toBe(401);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("returns 403 for a cross-origin request", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    mocks.employer = employerFor(company.id);
    const res = await upload(job.id, [pdf("a.pdf")], "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("returns 404 for another company's job and stores nothing", async () => {
    const { company } = makeCompany();
    const other = makeCompany();
    const foreignJob = makeJob(other.company.id);
    mocks.employer = employerFor(company.id);

    const res = await upload(foreignJob.id, [pdf("a.pdf")]);

    expect(res.status).toBe(404);
    expect(db.select().from(candidates).where(eq(candidates.jobId, foreignJob.id)).all()).toHaveLength(0);
  });

  it("returns 400 with no files", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    mocks.employer = employerFor(company.id);
    const res = await upload(job.id, []);
    expect(res.status).toBe(400);
  });

  it("returns 400 for more than 50 files without storing any", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    mocks.employer = employerFor(company.id);

    const res = await upload(job.id, Array.from({ length: 51 }, (_, i) => pdf(`cv-${i}.pdf`)));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Upload at most 50 CVs at a time." });
    expect(db.select().from(candidates).where(eq(candidates.jobId, job.id)).all()).toHaveLength(0);
  });

  it("stores valid files as pending uploads, reports per-file results and schedules only the created ids", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id, { status: "closed" });
    mocks.employer = employerFor(company.id);

    const res = await upload(job.id, [pdf("Jane Doe.pdf"), exe("virus.pdf"), pdf("John Roe.pdf")]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: number;
      results: Array<{ fileName: string; ok: boolean; candidateId?: string; error?: string }>;
    };
    expect(body.created).toBe(2);
    expect(body.results.map((r) => [r.fileName, r.ok])).toEqual([
      ["Jane Doe.pdf", true],
      ["virus.pdf", false],
      ["John Roe.pdf", true],
    ]);
    expect(body.results[1].error).toMatch(/isn't a supported CV/);

    const rows = db.select().from(candidates).where(eq(candidates.jobId, job.id)).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "pending", source: "upload", companyId: company.id });
      expect(fs.existsSync(path.join(process.env.UPLOAD_DIR!, row.cvFileKey))).toBe(true);
    }
    const createdIds = body.results.filter((r) => r.ok).map((r) => r.candidateId);
    expect(rows.map((r) => r.id).sort()).toEqual([...createdIds].sort());
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule).toHaveBeenCalledWith(createdIds);
  });

  it("does not schedule anything when every file is rejected", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    mocks.employer = employerFor(company.id);

    const res = await upload(job.id, [exe("a.pdf")]);

    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(0);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});
