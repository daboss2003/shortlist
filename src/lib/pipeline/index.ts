import "server-only";

// CONTRACT (frozen) — implemented by the AI/pipeline workstream.

/**
 * Queue candidates for text extraction + AI analysis without blocking the response.
 * Safe to call from Route Handlers and Server Actions (uses next/server `after()` when in a request).
 * Callers must have already set the candidate rows to status "pending".
 */
export function scheduleCandidateProcessing(candidateIds: string[]): void {
  void candidateIds;
  throw new Error("not implemented");
}

/** Run the full pipeline for one candidate now. Never throws: failures are written to the row. */
export async function processCandidate(candidateId: string): Promise<void> {
  void candidateId;
  throw new Error("not implemented");
}

/** On server boot: re-queue candidates left "pending"/"processing" by a previous process. */
export async function recoverInterruptedCandidates(): Promise<void> {
  throw new Error("not implemented");
}
