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

/** Process one candidate's CV. companyId is the fairness (concurrency) key. */
export const cvProcessRequested = eventType(CV_PROCESS_REQUESTED, {
  schema: z.object({ candidateId: z.string(), companyId: z.string() }),
});

/** Events per send request: keeps each request far below Inngest's payload limit. */
const SEND_BATCH = 200;

/**
 * Sends one `cv/process.requested` per candidate. With `dedupeKey`, each event gets the id `<dedupeKey>-<id>`, and
 * Inngest drops a repeat of that id within 24 hours.
 */
export async function sendCvProcessRequested(
  rows: Array<{ id: string; companyId: string }>,
  { dedupeKey }: { dedupeKey?: string } = {},
): Promise<void> {
  for (let i = 0; i < rows.length; i += SEND_BATCH) {
    await inngest.send(
      rows.slice(i, i + SEND_BATCH).map((row) => ({
        name: CV_PROCESS_REQUESTED,
        data: { candidateId: row.id, companyId: row.companyId },
        ...(dedupeKey ? { id: `${dedupeKey}-${row.id}` } : {}),
      })),
    );
  }
}
