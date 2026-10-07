export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureDbReady } = await import("@/db");
  await ensureDbReady();
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
