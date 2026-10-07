import { NextResponse } from "next/server";
import { z } from "zod";
import { BodyTooLargeError, readFormDataWithLimit } from "@/lib/body-limit";
import {
  CvValidationError,
  DuplicateApplicationError,
  createCandidateFromCv,
  validateCvUpload,
} from "@/lib/candidates/intake";
import { MAX_CV_BYTES } from "@/lib/cv/file-type";
import { getPublicJobBySlug } from "@/lib/data/jobs";
import { clientIp, jsonError } from "@/lib/http";
import { scheduleCandidateProcessing } from "@/lib/pipeline";
import { rateLimit } from "@/lib/rate-limit";
import { describeError } from "@/lib/log";
import { safeText } from "@/lib/validation";

type ApplyField = "name" | "email" | "phone" | "cv" | "consent";
type FieldErrors = Partial<Record<ApplyField, string>>;

const MAX_MB = MAX_CV_BYTES / (1024 * 1024);
// Intentional: only 256 KB on top of the CV (the text fields and multipart boundaries are a few KB). Netlify
// Functions accept ~4.5 MB of binary per request, so the cap must stay just above MAX_CV_BYTES.
const MAX_BODY_BYTES = MAX_CV_BYTES + 256 * 1024;
const PHONE_PATTERN = /^[0-9 +\-().]*$/;

const MESSAGES = {
  nameRequired: "Please enter your full name.",
  nameTooLong: "Please keep your name to 120 characters or fewer.",
  emailRequired: "Please enter your email address.",
  emailInvalid: "Please enter a valid email address.",
  emailTooLong: "Please keep your email address to 200 characters or fewer.",
  phoneInvalid: "Please enter a valid phone number using digits, spaces and + - ( ) . only.",
  phoneTooLong: "Please keep your phone number to 40 characters or fewer.",
  consent: "Please confirm you agree to share your CV.",
  cvRequired: "Please attach your CV.",
  cvTooLarge: `Your CV is larger than ${MAX_MB} MB. Please upload a smaller file.`,
} as const;

const applicationSchema = z.object({
  name: safeText({ error: MESSAGES.nameRequired })
    .trim()
    .min(1, MESSAGES.nameRequired)
    .max(120, MESSAGES.nameTooLong),
  email: safeText({ error: MESSAGES.emailRequired })
    .trim()
    .toLowerCase()
    .min(1, MESSAGES.emailRequired)
    .max(200, MESSAGES.emailTooLong)
    .pipe(z.email(MESSAGES.emailInvalid)),
  phone: safeText({ error: MESSAGES.phoneInvalid })
    .trim()
    .max(40, MESSAGES.phoneTooLong)
    .regex(PHONE_PATTERN, MESSAGES.phoneInvalid)
    .optional(),
  consent: z.literal("on", { error: MESSAGES.consent }),
  // An empty <input type="file"> is still submitted as a nameless, zero-byte File.
  cv: z
    .instanceof(File, { error: MESSAGES.cvRequired })
    .refine((file) => file.size > 0 || file.name !== "", MESSAGES.cvRequired),
});

const fieldErrorResponse = (fieldErrors: FieldErrors) => NextResponse.json({ fieldErrors }, { status: 400 });

function tooManyRequests(retryAfterSec: number) {
  return NextResponse.json(
    { error: "Too many submissions. Please try again in a few minutes." },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSec)) } },
  );
}

// Intentional: public because applicants have no account — protected by rate limit, honeypot and strict validation.
export async function POST(request: Request, ctx: RouteContext<"/api/apply/[slug]">) {
  try {
    const perIp = await rateLimit(`apply:${clientIp(request)}`, 5, 600_000);
    if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec);

    const { slug } = await ctx.params;
    const job = await getPublicJobBySlug(slug);
    if (!job) return jsonError(404, "This job link is invalid.");
    if (job.status !== "open") return jsonError(410, "This role is no longer accepting applications.");

    // Stops reading as soon as the cap is passed, so chunked bodies without a Content-Length are bounded too.
    let form: FormData;
    try {
      form = await readFormDataWithLimit(request, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return fieldErrorResponse({ cv: MESSAGES.cvTooLarge });
      return jsonError(400, "We couldn't read your application. Please try again.");
    }

    // Intentional: a filled honeypot gets a normal-looking success and nothing is stored, so bots aren't tipped off.
    const honeypot = form.get("hp_x7q");
    if (honeypot !== null && honeypot !== "") return NextResponse.json({ ok: true }, { status: 201 });

    const parsed = applicationSchema.safeParse({
      name: form.get("name") ?? undefined,
      email: form.get("email") ?? undefined,
      phone: form.get("phone") ?? undefined,
      consent: form.get("consent") ?? undefined,
      cv: form.get("cv") ?? undefined,
    });

    const fieldErrors: FieldErrors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as ApplyField;
        fieldErrors[field] ??= issue.message;
      }
    }

    // Check the file even when other fields failed, so the applicant sees every problem at once.
    const cvEntry = form.get("cv");
    let cv: Awaited<ReturnType<typeof validateCvUpload>> | null = null;
    if (!fieldErrors.cv && cvEntry instanceof File) {
      // Same wording whether the body cap or the file cap catches an oversized CV.
      if (cvEntry.size > MAX_CV_BYTES) {
        fieldErrors.cv = MESSAGES.cvTooLarge;
      } else {
        try {
          cv = await validateCvUpload(cvEntry);
        } catch (err) {
          if (!(err instanceof CvValidationError)) throw err;
          fieldErrors.cv = err.message;
        }
      }
    }

    if (!parsed.success || !cv || Object.keys(fieldErrors).length > 0) return fieldErrorResponse(fieldErrors);

    // Counted only for valid submissions: this cap exists to bound AI spend per job, not to punish typos.
    const perJob = await rateLimit(`apply-job:${slug}`, 300, 3_600_000);
    if (!perJob.ok) return tooManyRequests(perJob.retryAfterSec);

    const { name, email, phone } = parsed.data;
    let candidateId: string;
    try {
      const candidate = await createCandidateFromCv({
        job,
        source: "public",
        cv,
        applicant: { name, email, phone: phone || null },
      });
      candidateId = candidate.id;
    } catch (err) {
      if (err instanceof DuplicateApplicationError) return jsonError(409, err.message);
      throw err;
    }

    try {
      await scheduleCandidateProcessing([candidateId]);
    } catch (err) {
      // Intentional: the application is already stored as "pending", which the pipeline's periodic re-queue picks
      // up; a 500 here would make the applicant retry and hit the duplicate-application 409.
      console.error("Failed to schedule CV processing:", describeError(err));
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    // Intentional: describeError, never the raw error — Drizzle errors embed query params (the applicant's details).
    console.error("Public application failed:", describeError(err, { withStack: true }));
    return jsonError(500, "Something went wrong. Please try again.");
  }
}
