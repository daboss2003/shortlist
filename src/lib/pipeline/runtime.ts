// Where the app runs, and so how background work, CV storage and text extraction behave. Read from env on
// every call (not at import), so tests can stub it.

/**
 * Inside a Netlify Function: no persistent disk, no long-lived process, at most 60 s per invocation.
 * NETLIFY=true is the documented signal; the `Netlify` global is also set by the Functions runtime.
 */
export function isNetlify(): boolean {
  return process.env.NETLIFY === "true" || "Netlify" in globalThis;
}

/** Inngest is configured: an event key (Inngest Cloud) or INNGEST_DEV (the local Inngest Dev Server). */
export function isInngestEnabled(): boolean {
  return !!process.env.INNGEST_EVENT_KEY?.trim() || isInngestDev();
}

/** INNGEST_DEV is on: the SDK talks to a local Dev Server and does NOT verify the signature of incoming calls. */
export function isInngestDev(): boolean {
  const dev = process.env.INNGEST_DEV?.trim().toLowerCase();
  // The Inngest SDK reads "0" and "false" as "not dev mode".
  return !!dev && dev !== "0" && dev !== "false";
}

/**
 * How queued CVs are processed:
 * - "inngest": one durable Inngest run per CV (src/inngest/functions.ts); crons replace the in-process timers.
 * - "netlify-after": on Netlify without Inngest (a misconfiguration). CVs run in `after()` within the request's 60 s.
 * - "in-process": local / long-lived server. A fair in-process queue, boot recovery and interval timers.
 */
export type ExecutionMode = "inngest" | "netlify-after" | "in-process";

export function executionMode(): ExecutionMode {
  if (isInngestEnabled()) return "inngest";
  if (isNetlify()) return "netlify-after";
  return "in-process";
}
