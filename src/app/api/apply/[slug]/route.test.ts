import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { resetRateLimits } from "@/lib/rate-limit";
import { makeCompany, makeJob } from "../../../../../test/factories";
import { POST } from "./route";

const { scheduleSpy } = vi.hoisted(() => ({ scheduleSpy: vi.fn() }));
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

const rowsFor = (jobId: string) => db.select().from(candidates).where(eq(candidates.jobId, jobId)).all();

function openJob() {
  const { company } = makeCompany();
  return makeJob(company.id);
}

beforeEach(() => {
  resetRateLimits();
  scheduleSpy.mockReset();
});

describe("POST /api/apply/[slug]", () => {
  it("201: stores a pending public candidate with a normalized email and schedules it", async () => {
    const job = openJob();
    const res = await apply(job.slug, formData());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const rows = rowsFor(job.id);
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
    const job = openJob();
    const res = await apply(job.slug, formData({ phone: "" }));
    expect(res.status).toBe(201);
    expect(rowsFor(job.id)[0].phone).toBeNull();
  });

  it("400: returns field errors for an invalid email and missing consent, and stores nothing", async () => {
    const job = openJob();
    const res = await apply(job.slug, formData({ email: "not-an-email", consent: undefined }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({
      email: "Please enter a valid email address.",
      consent: "Please confirm you agree to share your CV.",
    });
    expect(rowsFor(job.id)).toHaveLength(0);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("400: rejects missing name, bad phone and a missing CV together", async () => {
    const job = openJob();
    const res = await apply(job.slug, formData({ name: "   ", phone: "call me maybe", cv: undefined }));

    expect(res.status).toBe(400);
    const { fieldErrors } = await res.json();
    expect(Object.keys(fieldErrors).sort()).toEqual(["cv", "name", "phone"]);
    expect(fieldErrors.cv).toBe("Please attach your CV.");
  });

  it("400: reports a file whose bytes aren't a supported CV under fieldErrors.cv", async () => {
    const job = openJob();
    const res = await apply(job.slug, formData({ cv: pdfFile(Buffer.from("MZ\x90\x00 not a pdf"), "cv.pdf") }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.cv).toMatch(/isn't a supported CV/);
    expect(rowsFor(job.id)).toHaveLength(0);
  });

  it("400: rejects an oversized body from its Content-Length before parsing it", async () => {
    const job = openJob();
    const res = await apply(job.slug, formData(), { headers: { "content-length": String(50 * 1024 * 1024) } });

    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.cv).toMatch(/larger than 5 MB/);
  });

  it("404: unknown slug", async () => {
    const res = await apply("no-such-job", formData());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This job link is invalid." });
  });

  it("410: closed job", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id, { status: "closed" });
    const res = await apply(job.slug, formData());

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "This role is no longer accepting applications." });
    expect(rowsFor(job.id)).toHaveLength(0);
  });

  it("409: a second application with the same email (any case) is rejected", async () => {
    const job = openJob();
    expect((await apply(job.slug, formData())).status).toBe(201);

    const res = await apply(job.slug, formData({ email: "JANE.DOE@example.com" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You've already applied for this role with this email address." });
    expect(rowsFor(job.id)).toHaveLength(1);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it("429: the 6th submission from one IP within 10 minutes is rejected with Retry-After", async () => {
    const job = openJob();
    for (let i = 0; i < 5; i++) {
      const res = await apply(job.slug, formData({ email: `applicant${i}@example.com` }), { ip: "203.0.113.7" });
      expect(res.status).toBe(201);
    }

    const res = await apply(job.slug, formData({ email: "applicant5@example.com" }), { ip: "203.0.113.7" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many submissions. Please try again in a few minutes." });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(rowsFor(job.id)).toHaveLength(5);

    const otherIp = await apply(job.slug, formData({ email: "someone@example.com" }), { ip: "203.0.113.8" });
    expect(otherIp.status).toBe(201);
  });

  it("429: caps valid submissions per job at 300 an hour, across IPs", async () => {
    const job = openJob();
    for (let i = 0; i < 300; i++) {
      const res = await apply(job.slug, formData({ email: `a${i}@example.com` }), { ip: `10.${Math.floor(i / 250)}.0.${i % 250}` });
      expect(res.status).toBe(201);
    }

    const res = await apply(job.slug, formData({ email: "late@example.com" }), { ip: "192.0.2.200" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(rowsFor(job.id)).toHaveLength(300);
  });

  it("honeypot: responds 201 but stores nothing and schedules nothing", async () => {
    const job = openJob();
    const res = await apply(job.slug, formData({ hp_x7q: "https://spam.example" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(rowsFor(job.id)).toHaveLength(0);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("still returns 201 if scheduling throws, since the application is stored", async () => {
    const job = openJob();
    scheduleSpy.mockImplementationOnce(() => {
      throw new Error("queue down");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await apply(job.slug, formData());
    expect(res.status).toBe(201);
    expect(rowsFor(job.id)).toHaveLength(1);
    errorLog.mockRestore();
  });
});
