import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { makeCompany, makeJob } from "../../../test/factories";
import {
  CvValidationError,
  DuplicateApplicationError,
  DuplicateCvError,
  createCandidateFromCv,
  validateCvUpload,
} from "./intake";

const pdfBytes = Buffer.from("%PDF-1.4\n% fake but correctly-signed pdf\n");
const pdfFile = (name = "Jane Doe CV.pdf", bytes: Uint8Array = pdfBytes) =>
  new File([new Uint8Array(bytes)], name, { type: "application/pdf" });

describe("validateCvUpload", () => {
  it("accepts a PDF by its magic bytes", async () => {
    const cv = await validateCvUpload(pdfFile());
    expect(cv).toMatchObject({ fileType: "pdf", mimeType: "application/pdf", fileName: "Jane Doe CV.pdf" });
  });

  it("accepts a legacy Word .doc by its OLE2 signature", async () => {
    const bytes = fs.readFileSync(path.join(process.cwd(), "test/fixtures/sample-cv.doc"));
    const cv = await validateCvUpload(new File([new Uint8Array(bytes)], "Emeka Nwosu CV.doc"));
    expect(cv).toMatchObject({ fileType: "doc", mimeType: "application/msword" });
    // Same bytes named .xls are not a CV.
    await expect(validateCvUpload(new File([new Uint8Array(bytes)], "sheet.xls"))).rejects.toBeInstanceOf(CvValidationError);
  });

  it("rejects a file whose bytes don't match a supported type, whatever its name", async () => {
    await expect(validateCvUpload(pdfFile("evil.pdf", Buffer.from("MZ\x90\x00 not a pdf")))).rejects.toBeInstanceOf(
      CvValidationError,
    );
  });

  it("rejects empty and oversized files", async () => {
    await expect(validateCvUpload(pdfFile("empty.pdf", Buffer.alloc(0)))).rejects.toThrow(/empty/);
    const big = Buffer.concat([pdfBytes, Buffer.alloc(5 * 1024 * 1024)]);
    await expect(validateCvUpload(pdfFile("big.pdf", big))).rejects.toThrow(/larger than 5 MB/);
  });

  it("strips path segments from the display name", async () => {
    const cv = await validateCvUpload(pdfFile("../../etc/passwd.pdf"));
    expect(cv.fileName).toBe("passwd.pdf");
  });
});

describe("createCandidateFromCv", () => {
  it("stores the file under a server-generated key and inserts a pending candidate", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const cv = await validateCvUpload(pdfFile());
    const c = await createCandidateFromCv({
      job,
      source: "public",
      cv,
      applicant: { name: "Jane Doe", email: "Jane@Example.com", phone: null },
    });
    expect(c).toMatchObject({ status: "pending", email: "jane@example.com", companyId: company.id, jobId: job.id });
    expect(c.cvFileKey).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR!, c.cvFileKey))).toBe(true);
  });

  it("rejects a second public application with the same email (case-insensitive) and cleans up the file", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const cv = await validateCvUpload(pdfFile());
    const applicant = { name: "Jane", email: "jane@example.com", phone: null };
    await createCandidateFromCv({ job, source: "public", cv, applicant });
    const filesBefore = fs.readdirSync(process.env.UPLOAD_DIR!).length;

    await expect(
      createCandidateFromCv({ job, source: "public", cv, applicant: { ...applicant, email: "JANE@example.com" } }),
    ).rejects.toBeInstanceOf(DuplicateApplicationError);
    expect(fs.readdirSync(process.env.UPLOAD_DIR!).length).toBe(filesBefore);
  });

  it("allows employer uploads without applicant details, skipping only byte-identical files", async () => {
    const { company } = makeCompany();
    const job = makeJob(company.id);
    const cv = await validateCvUpload(pdfFile());
    await createCandidateFromCv({ job, source: "upload", cv });
    await expect(createCandidateFromCv({ job, source: "upload", cv })).rejects.toBeInstanceOf(DuplicateCvError);

    const other = await validateCvUpload(pdfFile("Other.pdf", Buffer.from("%PDF-1.4\n% a different CV\n")));
    await createCandidateFromCv({ job, source: "upload", cv: other });
    expect(db.select().from(candidates).all().filter((c) => c.jobId === job.id)).toHaveLength(2);

    // The same file in a different job is fine.
    await createCandidateFromCv({ job: makeJob(company.id), source: "upload", cv });
  });
});
