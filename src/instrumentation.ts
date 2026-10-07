export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { seedPlatformAdmin } = await import("@/lib/auth/seed-admin");
  const { recoverInterruptedCandidates, startPendingRequeue } = await import("@/lib/pipeline");
  const { startRetentionSweeper } = await import("@/lib/retention");
  await seedPlatformAdmin();
  await recoverInterruptedCandidates();
  startPendingRequeue();
  startRetentionSweeper();
}
