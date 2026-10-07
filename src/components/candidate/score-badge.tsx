import { cn } from "@/lib/cn";
import { scoreTone } from "@/lib/format";

const toneCls = {
  success: "bg-success-soft text-success ring-success/20",
  warning: "bg-warning-soft text-warning ring-warning/20",
  danger: "bg-danger-soft text-danger ring-danger/20",
} as const;

/** 0–100 match score pill, coloured by scoreTone. Renders an em dash for null. */
export function ScoreBadge({ score, size = "md", className }: { score: number | null; size?: "md" | "lg"; className?: string }) {
  if (score === null) {
    return <span className={cn("text-sm text-ink-faint tabular-nums", className)}>—</span>;
  }
  return (
    <span
      aria-label={`Match score ${score} out of 100`}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-semibold tabular-nums ring-1 ring-inset",
        size === "lg" ? "min-w-14 px-2.5 py-1 text-xl" : "min-w-9 px-1.5 py-0.5 text-sm",
        toneCls[scoreTone(score)],
        className,
      )}
    >
      {score}
    </span>
  );
}
