import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import type { Employer } from "@/lib/auth/dal";
import { MAX_CV_BYTES } from "@/lib/cv/file-type";
import { makeCompany, makeJob } from "../../../../../../test/factories";

const mocks = vi.hoisted(() => ({
  employer: null as Employer | null,
  schedule: vi.fn(async () => {}),
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

/** Bytes depend on `content` (default: the name), so different names are different files unless told otherwise. */
const pdf = (name: string, content = name) =>
  new File([new Uint8Array(Buffer.from(`%PDF-1.4\n% ${content}\n`))], name, { type: "application/pdf" });
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

const rowsFor = (jobId: string) => db.select().from(candidates).where(eq(candidates.jobId, jobId));

async function signedInJob(overrides: Parameters<typeof makeJob>[1] = {}) {
  const { company } = await makeCompany();
  const job = await makeJob(company.id, overrides);
  mocks.employer = employerFor(company.id);
  return { company, job };
}

beforeEach(() => {
  mocks.employer = null;
  mocks.schedule.mockReset();
});

describe("POST /api/jobs/[jobId]/candidates", () => {
  it("returns 401 when signed out", async () => {
    const { company } = await makeCompany();
    const job = await makeJob(company.id);
    const res = await upload(job.id, [pdf("a.pdf")]);
    expect(res.status).toBe(401);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("returns 403 for a cross-origin request", async () => {
    const { job } = await signedInJob();
    const res = await upload(job.id, [pdf("a.pdf")], "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("returns 404 for another company's job and stores nothing", async () => {
    const { company } = await makeCompany();
    const other = await makeCompany();
    const foreignJob = await makeJob(other.company.id);
    mocks.employer = employerFor(company.id);

    const res = await upload(foreignJob.id, [pdf("a.pdf")]);

    expect(res.status).toBe(404);
    expect(await rowsFor(foreignJob.id)).toHaveLength(0);
  });

  it("returns 400 with no file", async () => {
    const { job } = await signedInJob();
    const res = await upload(job.id, []);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Choose a CV to upload." });
  });

  it("returns 400 for more than one file without storing any", async () => {
    const { job } = await signedInJob();
    const filesBefore = fs.readdirSync(process.env.UPLOAD_DIR!).length;

    const res = await upload(job.id, [pdf("one.pdf"), pdf("two.pdf")]);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Upload one CV per request." });
    expect(await rowsFor(job.id)).toHaveLength(0);
    expect(fs.readdirSync(process.env.UPLOAD_DIR!).length).toBe(filesBefore);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("returns 409 for a closed job and stores nothing", async () => {
    const { job } = await signedInJob({ status: "closed" });

    const res = await upload(job.id, [pdf("a.pdf")]);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This job is closed. Reopen it to add CVs." });
    expect(await rowsFor(job.id)).toHaveLength(0);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized chunked body (no Content-Length) without storing anything", async () => {
    const { job } = await signedInJob();

    const boundary = "----cvp-test-boundary";
    const encoder = new TextEncoder();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="huge.pdf"\r\n` +
              "Content-Type: application/pdf\r\n\r\n%PDF-1.4\n",
          ),
        );
      },
      pull(controller) {
        // 60 MB in total: far past the one-CV cap (4 MB + 256 KB).
        if (sent++ < 60) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const request = new Request(`http://localhost/api/jobs/${job.id}/candidates`, {
      method: "POST",
      body,
      duplex: "half",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, origin: "http://localhost", host: "localhost" },
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();

    const res = await POST(request, { params: Promise.resolve({ jobId: job.id }) });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "That CV is larger than 4 MB." });
    expect(sent).toBeLessThan(10);
    expect(await rowsFor(job.id)).toHaveLength(0);
  });

  it("returns 413 from the Content-Length alone before reading the body", async () => {
    const { job } = await signedInJob();
    const body = new FormData();
    body.append("files", pdf("a.pdf"));
    const request = new Request(`http://localhost/api/jobs/${job.id}/candidates`, {
      method: "POST",
      body,
      headers: { origin: "http://localhost", host: "localhost", "content-length": String(MAX_CV_BYTES + 512 * 1024) },
    });

    const res = await POST(request, { params: Promise.resolve({ jobId: job.id }) });

    expect(res.status).toBe(413);
    expect(await rowsFor(job.id)).toHaveLength(0);
  });

  it("accepts a CV of exactly 4 MB", async () => {
    const { job } = await signedInJob();
    const bytes = new Uint8Array(MAX_CV_BYTES);
    bytes.set(Buffer.from("%PDF-1.4\n"));

    const res = await upload(job.id, [new File([bytes], "max.pdf", { type: "application/pdf" })]);

    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(1);
  });

  it("reports a CV just over 4 MB (inside the body headroom) as a per-file error", async () => {
    const { job } = await signedInJob();
    const bytes = new Uint8Array(MAX_CV_BYTES + 1);
    bytes.set(Buffer.from("%PDF-1.4\n"));

    const res = await upload(job.id, [new File([bytes], "big.pdf", { type: "application/pdf" })]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: 0,
      results: [{ fileName: "big.pdf", ok: false, error: "big.pdf is larger than 4 MB." }],
    });
    expect(await rowsFor(job.id)).toHaveLength(0);
  });

  it("stores a valid file as a pending upload, reports its result and schedules it", async () => {
    const { company, job } = await signedInJob();

    const res = await upload(job.id, [pdf("Jane Doe.pdf")]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; results: Array<{ fileName: string; ok: boolean; candidateId?: string }> };
    expect(body.created).toBe(1);
    expect(body.results).toEqual([{ fileName: "Jane Doe.pdf", ok: true, candidateId: expect.any(String) }]);

    const rows = await rowsFor(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.results[0].candidateId, status: "pending", source: "upload", companyId: company.id });
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR!, rows[0].cvFileKey))).toBe(true);
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith([rows[0].id]);
  });

  it("reports a file that isn't a supported CV and schedules nothing", async () => {
    const { job } = await signedInJob();

    const res = await upload(job.id, [exe("virus.pdf")]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.results).toEqual([{ fileName: "virus.pdf", ok: false, error: expect.stringMatching(/isn't a supported CV/) }]);
    expect(await rowsFor(job.id)).toHaveLength(0);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("skips a file already uploaded to this job, but not one uploaded to another job", async () => {
    const { company, job } = await signedInJob();
    const otherJob = await makeJob(company.id);

    expect((await (await upload(job.id, [pdf("cv.pdf", "same")])).json()).created).toBe(1);
    mocks.schedule.mockReset();

    const again = await (await upload(job.id, [pdf("renamed.pdf", "same")])).json();
    expect(again).toEqual({
      created: 0,
      results: [{ fileName: "renamed.pdf", ok: false, code: "duplicate", error: "Already in this job." }],
    });
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(await rowsFor(job.id)).toHaveLength(1);

    expect((await (await upload(otherJob.id, [pdf("cv.pdf", "same")])).json()).created).toBe(1);
  });

  it("stores identical files sent at the same time once, reporting the other as a duplicate", async () => {
    const { job } = await signedInJob();

    // The client uploads two files at a time, so the database's unique index (not a pre-check) must decide.
    const responses = await Promise.all([upload(job.id, [pdf("a.pdf", "same")]), upload(job.id, [pdf("b.pdf", "same")])]);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(bodies.map((b) => b.created).sort()).toEqual([0, 1]);
    expect(bodies.flatMap((b) => b.results).filter((r) => r.code === "duplicate")).toHaveLength(1);
    expect(await rowsFor(job.id)).toHaveLength(1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
  });

  it("still returns the stored result if scheduling fails", async () => {
    const { job } = await signedInJob();
    mocks.schedule.mockRejectedValueOnce(new Error("queue down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await upload(job.id, [pdf("a.pdf")]);

    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(1);
    expect(await rowsFor(job.id)).toHaveLength(1);
    errors.mockRestore();
  });
});
