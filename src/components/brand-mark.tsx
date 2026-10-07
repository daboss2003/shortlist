import { cn } from "@/lib/cn";

/**
 * The Shortlist mark: a ranked list whose top entry is checked. Same artwork as src/app/icon.svg (the favicon) and
 * public/brand/ — keep them in sync. Hard-coded colours on purpose: a logo must look identical everywhere.
 */
export function BrandMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-7 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <rect width="32" height="32" rx="8" fill="#2346d4" />
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="3.8">
        <path d="M16 11.2h9.25" />
        <path d="M6.75 17.2h18.5" strokeOpacity=".55" />
        <path d="M6.75 23.2h12" strokeOpacity=".3" />
      </g>
      <circle cx="9.15" cy="11.2" r="4.3" fill="#34d399" />
      <path
        d="M7.35 11.3l1.3 1.3 2.4-2.6"
        fill="none"
        stroke="#063b26"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
