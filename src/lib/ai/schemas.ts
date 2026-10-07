import { z } from "zod";

// Every field is required-but-nullable (never optional): OpenAI strict structured
// outputs reject optional properties, and the other providers accept this shape too.

export const candidateProfileSchema = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  headline: z.string().nullable().describe("Current or most recent job title, or a one-line professional headline"),
  summary: z.string().nullable().describe("2-3 sentence neutral summary of the candidate's background"),
  totalExperienceYears: z.number().nullable().describe("Total years of professional experience, estimated from dates"),
  skills: z.array(z.string()).describe("Distinct technical and professional skills, most relevant first"),
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      startDate: z.string().nullable().describe("As written, or YYYY-MM if inferable"),
      endDate: z.string().nullable().describe("'Present' for a current role"),
      description: z.string().nullable(),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      graduationYear: z.string().nullable(),
    }),
  ),
  certifications: z.array(z.string()),
  languages: z.array(z.string()),
  links: z.array(z.string()).describe("LinkedIn, GitHub, portfolio or other URLs found in the CV"),
});
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

export const RECOMMENDATIONS = ["strong_fit", "good_fit", "possible_fit", "not_a_fit"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const evaluationSchema = z.object({
  overallScore: z.number().describe("Integer 0-100: overall fit for this specific job"),
  skillsScore: z.number().describe("Integer 0-100: coverage of required skills"),
  experienceScore: z.number().describe("Integer 0-100: relevance and seniority of experience"),
  educationScore: z.number().describe("Integer 0-100: relevance of education and certifications"),
  matchedSkills: z.array(z.string()).describe("Job skills the candidate demonstrably has"),
  missingSkills: z.array(z.string()).describe("Job skills with no evidence in the CV"),
  strengths: z.array(z.string()).describe("Up to 5 short, evidence-based strengths"),
  concerns: z.array(z.string()).describe("Up to 5 short, evidence-based gaps or risks"),
  summary: z.string().describe("2-3 sentence rationale for the score"),
  recommendation: z.enum(RECOMMENDATIONS),
});
export type Evaluation = z.infer<typeof evaluationSchema>;

/** What one AI call returns for one CV against one job. */
export const cvAnalysisSchema = z.object({
  profile: candidateProfileSchema,
  evaluation: evaluationSchema,
});
export type CvAnalysis = z.infer<typeof cvAnalysisSchema>;
