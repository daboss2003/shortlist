import { describe, expect, it } from "vitest";
import type { Candidate } from "@/db/schema";
import type { CandidateProfile, Evaluation } from "@/lib/ai/schemas";
import { EXPORT_COLUMNS, neutralizeFormula, toExportRows } from "./rows";

const profile: CandidateProfile = {
  fullName: "José Álvarez",
  email: "jose@example.com",
  phone: "+34 600 000 000",
  location: "Madrid, Spain",
  headline: "Senior Backend Engineer",
  summary: "Backend engineer.",
  totalExperienceYears: 7.5,
  skills: ["Node.js", "PostgreSQL", "AWS"],
  experience: [
    { title: "Staff Engineer", company: "Globex", startDate: "2021-01", endDate: "Present", description: null },
    { title: "Engineer", company: "Initech", startDate: "2017-01", endDate: "2020-12", description: null },
  ],
  education: [{ institution: "UPM", degree: "BSc", field: "Computer Science", graduationYear: "2016" }],
  certifications: ["AWS SAA"],
  languages: ["Spanish", "English"],
  links: ["https://github.com/jose", "https://linkedin.com/in/jose"],
};

const evaluation: Evaluation = {
  overallScore: 88,
  skillsScore: 90,
  experienceScore: 85,
  educationScore: 70,
  matchedSkills: ["Node.js", "PostgreSQL"],
  missingSkills: ["TypeScript"],
  strengths: ["Payments experience", "Led a team"],
  concerns: ["No TypeScript"],
  summary: "Strong backend fit.",
  recommendation: "strong_fit",
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: crypto.randomUUID(),
    jobId: "job",
    companyId: "company",
    source: "upload",
    name: null,
    email: null,
    phone: null,
    cvFileKey: `${crypto.randomUUID()}.pdf`,
    cvFileName: "cv.pdf",
    cvMimeType: "application/pdf",
    cvSize: 100,
    cvText: null,
    profile: null,
    evaluation: null,
    score: null,
    status: "pending",
    error: null,
    aiProvider: null,
    aiModel: null,
    stage: "new",
    createdAt: new Date("2026-03-04T23:30:00Z"),
    processedAt: null,
    ...overrides,
  };
}

const ready = () =>
  candidate({
    source: "public",
    name: "Jose Alvarez",
    email: "applicant@example.com",
    phone: null,
    profile,
    evaluation,
    score: 88,
    status: "ready",
    aiProvider: "gemini",
    aiModel: "gemini-2.5-flash",
    stage: "shortlisted",
    cvFileName: "Jose CV.pdf",
  });

describe("toExportRows", () => {
  it("maps every column of a ranked candidate", () => {
    const [row] = toExportRows([ready()]);
    expect(Object.keys(row)).toEqual([...EXPORT_COLUMNS]);
    expect(row).toEqual({
      Rank: 1,
      Name: "Jose Alvarez",
      Email: "applicant@example.com",
      Phone: "+34 600 000 000",
      Location: "Madrid, Spain",
      Headline: "Senior Backend Engineer",
      "Total experience (years)": 7.5,
      "Match score": 88,
      Recommendation: "Strong fit",
      "Skills score": 90,
      "Experience score": 85,
      "Education score": 70,
      "Matched skills": "Node.js; PostgreSQL",
      "Missing skills": "TypeScript",
      Strengths: "Payments experience | Led a team",
      Concerns: "No TypeScript",
      "AI summary": "Strong backend fit.",
      "All skills": "Node.js; PostgreSQL; AWS",
      "Most recent role": "Staff Engineer at Globex",
      Education: "BSc, Computer Science — UPM (2016)",
      Certifications: "AWS SAA",
      Languages: "Spanish; English",
      Links: "https://github.com/jose; https://linkedin.com/in/jose",
      Stage: "Shortlisted",
      Source: "Applied via link",
      "Analysis status": "Ranked",
      "Added on": "2026-03-04",
      "CV file": "Jose CV.pdf",
      "Ranked by": "gemini / gemini-2.5-flash",
    });
  });

  it("leaves AI cells empty for a pending candidate without a profile or evaluation", () => {
    const [row] = toExportRows([candidate({ cvFileName: "upload.docx" })]);
    expect(row).toMatchObject({
      Rank: 1,
      Name: "upload.docx",
      Email: null,
      Phone: null,
      Location: null,
      "Total experience (years)": null,
      "Match score": null,
      Recommendation: null,
      "Skills score": null,
      "Matched skills": null,
      Strengths: null,
      "AI summary": null,
      "All skills": null,
      "Most recent role": null,
      Education: null,
      Links: null,
      Stage: "New",
      Source: "Uploaded by team",
      "Analysis status": "Queued",
      "Ranked by": null,
    });
  });

  it("falls back to profile name/email/phone, and treats blanks as missing", () => {
    const [row] = toExportRows([candidate({ name: "", profile, status: "ready" })]);
    expect(row).toMatchObject({ Name: "José Álvarez", Email: "jose@example.com", Phone: "+34 600 000 000" });
  });

  it("includes the error for a failed analysis", () => {
    const [row] = toExportRows([candidate({ status: "failed", error: "Couldn't read the PDF" })]);
    expect(row["Analysis status"]).toBe("Failed: Couldn't read the PDF");
  });

  it("formats partial education and roles without dangling separators", () => {
    const partial: CandidateProfile = {
      ...profile,
      experience: [{ title: "Engineer", company: "", startDate: null, endDate: null, description: null }],
      education: [{ institution: "MIT", degree: null, field: "Physics", graduationYear: null }],
    };
    const [row] = toExportRows([candidate({ profile: partial })]);
    expect(row["Most recent role"]).toBe("Engineer");
    expect(row.Education).toBe("Physics — MIT");
  });

  it("numbers rows by their position in the given (ranked) list", () => {
    const rows = toExportRows([candidate({ name: "A" }), candidate({ name: "B" }), candidate({ name: "C" })]);
    expect(rows.map((r) => [r.Rank, r.Name])).toEqual([
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ]);
  });
});

describe("neutralizeFormula", () => {
  it("prefixes strings a spreadsheet would treat as a formula", () => {
    for (const s of ["=1+1", "+cmd|' /C calc'!A0", "-2+3+cmd|' /C calc'!A0", "@SUM(A1)", "\tx", "\rx", "-", "+"]) {
      expect(neutralizeFormula(s)).toBe(`'${s}`);
    }
    expect(neutralizeFormula("Jane")).toBe("Jane");
    expect(neutralizeFormula("")).toBe("");
  });

  it("leaves digits-only values such as phone numbers untouched", () => {
    for (const s of ["+234 803 555 0142", "+1 (555) 010-9999", "-5", "+44 20 7946 0000"]) {
      expect(neutralizeFormula(s)).toBe(s);
    }
  });
});
