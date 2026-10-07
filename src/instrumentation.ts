export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recoverInterruptedCandidates } = await import("@/lib/pipeline");
  await recoverInterruptedCandidates();
}
