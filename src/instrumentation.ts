export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureDbReady, findSchemaProblem } = await import("@/db");
  await ensureDbReady();
  const problem = await findSchemaProblem().catch((err: unknown) =>
    `Couldn't reach the database at DATABASE_URL: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
  );
  if (problem) {
    // Intentional: start anyway (pages show the error boundary) but say exactly what to fix, once, at boot —
    // instead of an opaque "relation does not exist" on the first login.
    console.error(`[db] ${problem}`);
    return;
  }
  const { seedPlatformAdmin } = await import("@/lib/auth/seed-admin");
  await seedPlatformAdmin();

  // Boot recovery and the interval timers only make sense in a long-lived process. On serverless (and whenever
  // Inngest is configured) the Inngest crons in src/inngest/functions.ts do this work instead.
  const { executionMode } = await import("@/lib/pipeline/runtime");
  if (executionMode() !== "in-process") return;

  const { recoverInterruptedCandidates, startPendingRequeue } = await import("@/lib/pipeline");
  const { startRetentionSweeper } = await import("@/lib/retention");
  await recoverInterruptedCandidates();
  startPendingRequeue();
  startRetentionSweeper();
}
