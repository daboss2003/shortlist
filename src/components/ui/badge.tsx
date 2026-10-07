import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-subtle text-ink-muted ring-line",
  brand: "bg-brand-soft text-brand-ink ring-brand/15",
  success: "bg-success-soft text-success ring-success/15",
  warning: "bg-warning-soft text-warning ring-warning/15",
  danger: "bg-danger-soft text-danger ring-danger/15",
};

/**
 * `wrap`: for chips showing free text (skills, languages). The chip may wrap onto several lines and break a long
 * unspaced token (a URL, "A/B/C/D") so it never grows wider than its container. Default chips stay on one line.
 */
export function Badge({
  tone = "neutral",
  wrap = false,
  className,
  ...props
}: ComponentProps<"span"> & { tone?: BadgeTone; wrap?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset [&_svg]:size-3",
        wrap ? "max-w-full text-left whitespace-normal [overflow-wrap:anywhere]" : "whitespace-nowrap",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
