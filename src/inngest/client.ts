import "server-only";
import { Inngest, eventType } from "inngest";
import { z } from "zod";

// Durable background jobs on serverless (see src/inngest/functions.ts, served at /api/inngest). The SDK reads
// INNGEST_EVENT_KEY (to send events) and INNGEST_SIGNING_KEY (to verify Inngest's calls) from env; INNGEST_DEV=1
// points it at a local Inngest Dev Server instead.

export const inngest = new Inngest({
  id: "cv-review-pipeline",
  // Intentional: off, though v4 defaults it on. Checkpointing runs several steps in one HTTP request and can start a
  // step late in it; with it off every step is its own request, so each one alone must fit Netlify's 60 s limit.
  checkpointing: false,
});

export const CV_PROCESS_REQUESTED = "cv/process.requested";

/**
 * Process one candidate's CV. companyId is the fairness (concurrency) key. Inngest stores event data, so it holds
 * ids only: never the CV, the candidate's name or contact details.
 */
export const cvProcessRequested = eventType(CV_PROCESS_REQUESTED, {
  schema: z.object({ candidateId: z.string(), companyId: z.string() }),
});

/** Events per send request: keeps each request far below Inngest's payload limit. */
const SEND_BATCH = 200;

/**
 * Sends one `cv/process.requested` per row, with the row's event id: Inngest drops an event whose id it has seen in
 * the last 24 hours (see processEventId in src/lib/pipeline/index.ts).
 */
export async function sendCvProcessRequested(
  rows: Array<{ id: string; companyId: string; eventId: string }>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += SEND_BATCH) {
    await inngest.send(
      rows.slice(i, i + SEND_BATCH).map((row) => ({
        id: row.eventId,
        name: CV_PROCESS_REQUESTED,
        data: { candidateId: row.id, companyId: row.companyId },
      })),
    );
  }
}
