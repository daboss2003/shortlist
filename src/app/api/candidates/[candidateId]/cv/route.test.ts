import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Employer } from "@/lib/auth/dal";
import { createCandidateFromCv, validateCvUpload } from "@/lib/candidates/intake";
import { makeCompany, makeJob } from "../../../../../../test/factories";

const mocks = vi.hoisted(() => ({ employer: null as Employer | null }));
vi.mock("@/lib/auth/dal", () => ({
  getCurrentEmployer: async () => mocks.employer,
  requireEmployer: async () => mocks.employer,
}));

const { GET } = await import("./route");

const employerFor = (companyId: string): Employer => ({
  userId: "u",
  name: "Owner",
  email: "owner@example.com",
  companyId,
  companyName: "Acme",
  companyWebsite: null,
});

const pdfBytes = Buffer.from("%PDF-1.4\n% downloadable cv\n");

async function makeCandidate(fileName: string) {
  const { company } = await makeCompany();
  const job = await makeJob(company.id);
  const cv = await validateCvUpload(new File([new Uint8Array(pdfBytes)], fileName, { type: "application/pdf" }));
  const candidate = await createCandidateFromCv({ job, source: "upload", cv });
  return { company, candidate };
}

const download = (candidateId: string) =>
  GET(new Request(`http://localhost/api/candidates/${candidateId}/cv`), { params: Promise.resolve({ candidateId }) });

beforeEach(() => {
  mocks.employer = null;
});

describe("GET /api/candidates/[candidateId]/cv", () => {
  it("returns 401 when signed out", async () => {
    const { candidate } = await makeCandidate("cv.pdf");
    expect((await download(candidate.id)).status).toBe(401);
  });

  it("returns the original bytes as a private attachment", async () => {
    const { company, candidate } = await makeCandidate("Zoë O'Brien CV.pdf");
    mocks.employer = employerFor(company.id);

    const res = await download(candidate.id);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Zo_ O'Brien CV.pdf"; filename*=UTF-8''Zo%C3%AB%20O%27Brien%20CV.pdf`,
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(pdfBytes)).toBe(true);
  });

  it("names the download after the stored type, not the uploaded extension", async () => {
    const cases: Array<[uploaded: string, downloaded: string]> = [
      ["cv.docx", "cv.pdf"],
      ["Resume", "Resume.pdf"],
      ["CV v2.1", "CV v2.1.pdf"],
      ["scan.PDF", "scan.PDF"],
      [".docx", "cv.pdf"],
    ];
    for (const [uploaded, downloaded] of cases) {
      const { company, candidate } = await makeCandidate(uploaded);
      mocks.employer = employerFor(company.id);
      expect(candidate.cvFileName).toBe(uploaded);

      const res = await download(candidate.id);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition"), uploaded).toBe(
        `attachment; filename="${downloaded}"; filename*=UTF-8''${encodeURIComponent(downloaded)}`,
      );
    }
  });

  it("returns 404 for another company's candidate", async () => {
    const { candidate } = await makeCandidate("cv.pdf");
    const other = await makeCompany();
    mocks.employer = employerFor(other.company.id);

    const res = await download(candidate.id);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("returns 404 for a missing candidate", async () => {
    const { company } = await makeCandidate("cv.pdf");
    mocks.employer = employerFor(company.id);
    expect((await download(crypto.randomUUID())).status).toBe(404);
  });

  it("returns 404 JSON when the file is gone from disk", async () => {
    const { company, candidate } = await makeCandidate("cv.pdf");
    mocks.employer = employerFor(company.id);
    fs.rmSync(path.join(process.env.UPLOAD_DIR!, candidate.cvFileKey));

    const res = await download(candidate.id);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});
