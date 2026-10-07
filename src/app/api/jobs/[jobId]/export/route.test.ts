import { eq } from "drizzle-orm";
import { Workbook } from "exceljs";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { candidates, type Candidate, type CandidateStage } from "@/db/schema";
import { getCurrentEmployer, type Employer } from "@/lib/auth/dal";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../../../../test/factories";
import { GET } from "./route";

vi.mock("@/lib/auth/dal", () => ({ getCurrentEmployer: vi.fn() }));

function signInAs(company: { id: string; name: string } | null) {
  const employer: Employer | null = company
    ? {
        userId: crypto.randomUUID(),
        name: "Owner",
        email: "owner@example.com",
        companyId: company.id,
        companyName: company.name,
        companyWebsite: null,
      }
    : null;
  vi.mocked(getCurrentEmployer).mockResolvedValue(employer);
}

function exportRequest(jobId: string, query: string) {
  return GET(new Request(`http://localhost/api/jobs/${jobId}/export?${query}`), {
    params: Promise.resolve({ jobId }),
  });
}

async function addCandidate(
  job: { id: string; companyId: string },
  name: string,
  opts: { score?: number | null; stage?: CandidateStage } = {},
): Promise<Candidate> {
  const cv = await validateCvUpload(new File([`%PDF-1.4 CV of ${name}`], `${name}.pdf`));
  const created = await createCandidateFromCv({
    job,
    source: "public",
    cv,
    applicant: { name, email: `${crypto.randomUUID()}@example.com`, phone: null },
  });
  return db
    .update(candidates)
    .set({
      score: opts.score ?? null,
      status: opts.score == null ? "pending" : "ready",
      stage: opts.stage ?? "new",
    })
    .where(eq(candidates.id, created.id))
    .returning()
    .get();
}

/** Candidate names in CSV order (column 2), header skipped. */
async function csvNames(res: Response) {
  const lines = (await res.text()).replace(/^﻿/, "").trim().split("\r\n").slice(1);
  return lines.map((line) => line.split(",")[1]);
}

async function setup() {
  const { company } = makeCompany();
  const job = makeJob(company.id, { title: "Senior Backend Engineer" });
  const low = await addCandidate(job, "Low Score", { score: 40, stage: "rejected" });
  const high = await addCandidate(job, "High Score", { score: 92, stage: "shortlisted" });
  const pending = await addCandidate(job, "Still Pending");
  const mid = await addCandidate(job, "Mid Score", { score: 70, stage: "shortlisted" });
  signInAs(company);
  return { company, job, low, high, pending, mid };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-07T23:30:00Z"), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(getCurrentEmployer).mockReset();
});

describe("GET /api/jobs/[jobId]/export", () => {
  it("returns 401 when signed out", async () => {
    const { job } = await setup();
    signInAs(null);
    const res = await exportRequest(job.id, "format=csv");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("returns 404 for another company's job, exactly like a missing one", async () => {
    const { job } = await setup();
    const { company: other } = makeCompany();
    signInAs(other);
    expect((await exportRequest(job.id, "format=csv")).status).toBe(404);
    expect((await exportRequest(crypto.randomUUID(), "format=csv")).status).toBe(404);
    expect((await exportRequest("not-a-uuid", "format=csv")).status).toBe(404);
  });

  it("rejects a bad format, stage or ids with 400 JSON", async () => {
    const { job, high } = await setup();
    for (const query of [
      "",
      "format=pdf",
      "format=csv&stage=hired",
      "format=csv&ids=not-a-uuid",
      `format=csv&ids=${high.id},1;drop table`,
      "format=csv&ids=",
      `format=csv&ids=${Array.from({ length: 1001 }, () => crypto.randomUUID()).join(",")}`,
    ]) {
      const res = await exportRequest(job.id, query);
      expect(res.status, query.slice(0, 60)).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
  });

  it("exports every candidate as CSV in ranked order with download headers", async () => {
    const { job } = await setup();
    const res = await exportRequest(job.id, "format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="senior-backend-engineer-candidates-2026-10-07.csv"',
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await csvNames(res)).toEqual(["High Score", "Mid Score", "Low Score", "Still Pending"]);
  });

  it("exports only the selected ids, still ranked, silently dropping another company's ids", async () => {
    const { job, low, high } = await setup();
    const { company: other } = makeCompany();
    const foreign = await addCandidate(makeJob(other.id), "Foreign Person", { score: 99 });

    const res = await exportRequest(job.id, `format=csv&ids=${low.id},${foreign.id},${high.id}`);
    expect(res.status).toBe(200);
    expect(await csvNames(res)).toEqual(["High Score", "Low Score"]);

    const onlyForeign = await exportRequest(job.id, `format=csv&ids=${foreign.id}`);
    expect(onlyForeign.status).toBe(400);
    expect(await onlyForeign.json()).toEqual({ error: "No candidates to export." });
  });

  it("filters by stage", async () => {
    const { job } = await setup();
    expect(await csvNames(await exportRequest(job.id, "format=csv&stage=shortlisted"))).toEqual([
      "High Score",
      "Mid Score",
    ]);
    expect(await csvNames(await exportRequest(job.id, "format=csv&stage=rejected"))).toEqual(["Low Score"]);
  });

  it("returns 400 when there is nothing to export", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    signInAs(company);
    const res = await exportRequest(job.id, "format=xlsx");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No candidates to export." });
  });

  it("returns an Excel workbook", async () => {
    const { job } = await setup();
    const res = await exportRequest(job.id, "format=xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toMatch(/filename="senior-backend-engineer-candidates-2026-10-07\.xlsx"$/);

    const wb = new Workbook();
    await wb.xlsx.load((await res.arrayBuffer()) as never);
    const sheet = wb.worksheets[0];
    expect(sheet.name).toBe("Senior Backend Engineer");
    expect(sheet.getCell("B2").value).toBe("High Score");
    expect(sheet.rowCount).toBe(5);
  });

  it("returns a zip of the spreadsheets and the original CVs", async () => {
    const { job } = await setup();
    const res = await exportRequest(job.id, "format=zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/filename="senior-backend-engineer-candidates-2026-10-07\.zip"$/);

    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "senior-backend-engineer-candidates-2026-10-07.csv",
        "senior-backend-engineer-candidates-2026-10-07.xlsx",
        "cvs/001-High-Score.pdf",
        "cvs/004-Still-Pending.pdf",
      ]),
    );
    expect(await zip.file("cvs/001-High-Score.pdf")!.async("string")).toBe("%PDF-1.4 CV of High Score");
  });

  it("slugs awkward job titles into a safe ASCII file name", async () => {
    const { company } = makeCompany();
    signInAs(company);
    const titled = async (title: string) => {
      const job = makeJob(company.id, { title });
      await addCandidate(job, "Someone", { score: 50 });
      const disposition = (await exportRequest(job.id, "format=csv")).headers.get("content-disposition")!;
      return disposition.match(/filename="(.+)"$/)![1];
    };
    expect(await titled('Café "Lead" / Ops: Ünïcode')).toBe("cafe-lead-ops-unicode-candidates-2026-10-07.csv");
    expect(await titled("工程师")).toBe("job-candidates-2026-10-07.csv");
    const long = await titled("Principal ".repeat(10));
    expect(long.split("-candidates-")[0].length).toBeLessThanOrEqual(50);
    expect(long).toMatch(/^principal-principal(-principal)*-candidates-2026-10-07\.csv$/);
  });
});
