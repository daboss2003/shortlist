import fs from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { MAX_CV_BYTES } from "@/lib/cv/file-type";
import { resetRateLimits } from "@/lib/rate-limit";
import { makeCompany, makeJob } from "../../../../../test/factories";
import { POST } from "./route";

const { scheduleSpy } = vi.hoisted(() => ({ scheduleSpy: vi.fn(async () => {}) }));
vi.mock("@/lib/pipeline", () => ({ scheduleCandidateProcessing: scheduleSpy }));

const pdfBytes = Buffer.from("%PDF-1.4\n% fake but correctly-signed pdf\n");
const pdfFile = (bytes: Uint8Array = pdfBytes, name = "Jane Doe CV.pdf") =>
  new File([new Uint8Array(bytes)], name, { type: "application/pdf" });

type Fields = Partial<Record<"name" | "email" | "phone" | "consent" | "hp_x7q", string>> & { cv?: File };

function formData(overrides: Fields = {}) {
  const fields: Fields = {
    name: "  Jane Doe ",
    email: "Jane.Doe@Example.com",
    phone: "+44 (0)20 7946-0958",
    consent: "on",
    hp_x7q: "",
    cv: pdfFile(),
    ...overrides,
  };
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) fd.set(key, value);
  return fd;
}

function apply(slug: string, body: FormData, init: { ip?: string; headers?: Record<string, string> } = {}) {
  const request = new Request(`http://localhost/api/apply/${slug}`, {
    method: "POST",
    body,
    headers: { "x-forwarded-for": init.ip ?? "198.51.100.1", ...init.headers },
  });
  return POST(request, { params: Promise.resolve({ slug }) });
}

/**
 * Sends the body as a stream of chunks with no Content-Length, like a chunked upload, and reports how many
 * bytes the route pulled from it.
 */
async function applyStreamed(slug: string, body: FormData, chunkSize = 64 * 1024) {
  const encoded = new Response(body);
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(pulled, pulled + chunkSize));
      pulled = Math.min(pulled + chunkSize, bytes.length);
    },
  });
  const request = new Request(`http://localhost/api/apply/${slug}`, {
    method: "POST",
    body: stream,
    headers: { "content-type": encoded.headers.get("content-type")!, "x-forwarded-for": "198.51.100.1" },
    duplex: "half",
  } as RequestInit);
  expect(request.headers.get("content-length")).toBeNull();
  const res = await POST(request, { params: Promise.resolve({ slug }) });
  return { res, bytesRead: pulled, totalBytes: bytes.length };
}

const rowsFor = (jobId: string) => db.select().from(candidates).where(eq(candidates.jobId, jobId));
const storedFiles = () => fs.readdirSync(process.env.UPLOAD_DIR!).sort();
const CV_TOO_LARGE = "Your CV is larger than 4 MB. Please upload a smaller file.";

async function openJob() {
  const { company } = await makeCompany();
  return makeJob(company.id);
}

beforeEach(async () => {
  await resetRateLimits();
  scheduleSpy.mockReset();
});

describe("POST /api/apply/[slug]", () => {
  it("201: stores a pending public candidate with a normalized email and schedules it", async () => {
    const job = await openJob();
    const res = await apply(job.slug, formData());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await rowsFor(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      source: "public",
      name: "Jane Doe",
      email: "jane.doe@example.com",
      phone: "+44 (0)20 7946-0958",
      companyId: job.companyId,
      cvFileName: "Jane Doe CV.pdf",
    });
    expect(scheduleSpy).toHaveBeenCalledExactlyOnceWith([rows[0].id]);
  });

  it("stores an omitted phone as null", async () => {
    const job = await openJob();
    const res = await apply(job.slug, formData({ phone: "" }));
    expect(res.status).toBe(201);
    expect((await rowsFor(job.id))[0].phone).toBeNull();
  });

  it("400: returns field errors for an invalid email and missing consent, and stores nothing", async () => {
    const job = await openJob();
    const res = await apply(job.slug, formData({ email: "not-an-email", consent: undefined }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({
      email: "Please enter a valid email address.",
      consent: "Please confirm you agree to share your CV.",
    });
    expect(await rowsFor(job.id)).toHaveLength(0);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("400: rejects missing name, bad phone and a missing CV together", async () => {
    const job = await openJob();
    const res = await apply(job.slug, formData({ name: "   ", phone: "call me maybe", cv: undefined }));

    expect(res.status).toBe(400);
    const { fieldErrors } = await res.json();
    expect(Object.keys(fieldErrors).sort()).toEqual(["cv", "name", "phone"]);
    expect(fieldErrors.cv).toBe("Please attach your CV.");
  });

  it("400: reports a file whose bytes aren't a supported CV under fieldErrors.cv", async () => {
    const job = await openJob();
    const res = await apply(job.slug, formData({ cv: pdfFile(Buffer.from("MZ\x90\x00 not a pdf"), "cv.pdf") }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.cv).toMatch(/isn't a supported CV/);
    expect(await rowsFor(job.id)).toHaveLength(0);
  });

  it("400: rejects an oversized body from its Content-Length before parsing it", async () => {
    const job = await openJob();
    const res = await apply(job.slug, formData(), { headers: { "content-length": String(50 * 1024 * 1024) } });

    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.cv).toBe(CV_TOO_LARGE);
  });

  it("201: accepts a valid application streamed in chunks with no Content-Length", async () => {
    const job = await openJob();
    const { res } = await applyStreamed(job.slug, formData());

    expect(res.status).toBe(201);
    expect(await rowsFor(job.id)).toHaveLength(1);
  });

  it("400: rejects an over-cap chunked body with no Content-Length, stops reading early and stores nothing", async () => {
    const job = await openJob();
    const filesBefore = storedFiles();
    // Otherwise valid: without a streaming cap this would be accepted and the padding buffered in memory.
    const body = formData();
    body.set("notes", new File([new Uint8Array(16 * 1024 * 1024)], "padding.bin"));

    const { res, bytesRead, totalBytes } = await applyStreamed(job.slug, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ fieldErrors: { cv: CV_TOO_LARGE } });
    expect(totalBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(bytesRead).toBeLessThan(MAX_CV_BYTES + 2 * 1024 * 1024);
    expect(await rowsFor(job.id)).toHaveLength(0);
    expect(storedFiles()).toEqual(filesBefore);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("400: a CV over 4 MB that fits inside the body headroom is still rejected, with the same message", async () => {
    const job = await openJob();
    const filesBefore = storedFiles();
    const bigPdf = new Uint8Array(MAX_CV_BYTES + 128 * 1024);
    bigPdf.set(pdfBytes);

    const res = await apply(job.slug, formData({ cv: pdfFile(bigPdf) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ fieldErrors: { cv: CV_TOO_LARGE } });
    expect(await rowsFor(job.id)).toHaveLength(0);
    expect(storedFiles()).toEqual(filesBefore);
  });

  it("404: unknown slug", async () => {
    const res = await apply("no-such-job", formData());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This job link is invalid." });
  });

  it("410: closed job", async () => {
    const { company } = await makeCompany();
    const job = await makeJob(company.id, { status: "closed" });
    const res = await apply(job.slug, formData());

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "This role is no longer accepting applications." });
    expect(await rowsFor(job.id)).toHaveLength(0);
  });

  it("409: a second application with the same email (any case) is rejected", async () => {
    const job = await openJob();
    expect((await apply(job.slug, formData())).status).toBe(201);

    const res = await apply(job.slug, formData({ email: "JANE.DOE@example.com" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You've already applied for this role with this email address." });
    expect(await rowsFor(job.id)).toHaveLength(1);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it("429: the 6th submission from one IP within 10 minutes is rejected with Retry-After", async () => {
    const job = await openJob();
    for (let i = 0; i < 5; i++) {
      const res = await apply(job.slug, formData({ email: `applicant${i}@example.com` }), { ip: "203.0.113.7" });
      expect(res.status).toBe(201);
    }

    const res = await apply(job.slug, formData({ email: "applicant5@example.com" }), { ip: "203.0.113.7" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many submissions. Please try again in a few minutes." });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await rowsFor(job.id)).toHaveLength(5);

    const otherIp = await apply(job.slug, formData({ email: "someone@example.com" }), { ip: "203.0.113.8" });
    expect(otherIp.status).toBe(201);
  });

  it("429: caps valid submissions per job at 300 an hour, across IPs", async () => {
    const job = await openJob();
    for (let i = 0; i < 300; i++) {
      const res = await apply(job.slug, formData({ email: `a${i}@example.com` }), { ip: `10.${Math.floor(i / 250)}.0.${i % 250}` });
      expect(res.status).toBe(201);
    }

    const res = await apply(job.slug, formData({ email: "late@example.com" }), { ip: "192.0.2.200" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(await rowsFor(job.id)).toHaveLength(300);
    // Intentional: 30 s, not the 5 s default — 300 full submissions, each several Postgres round trips.
  }, 30_000);

  it("honeypot: responds 201 but stores nothing and schedules nothing", async () => {
    const job = await openJob();
    const res = await apply(job.slug, formData({ hp_x7q: "https://spam.example" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rowsFor(job.id)).toHaveLength(0);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("still returns 201 if scheduling throws, since the application is stored", async () => {
    const job = await openJob();
    scheduleSpy.mockImplementationOnce(async () => {
      throw new Error("queue down");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await apply(job.slug, formData());
    expect(res.status).toBe(201);
    expect(await rowsFor(job.id)).toHaveLength(1);
    errorLog.mockRestore();
  });
});
