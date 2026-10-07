import { CircleSlash } from "lucide-react";

/** Card content for a job that no longer takes applications: on page load, or when a stale page submits. */
export function ClosedNotice({ companyName, headingId }: { companyName: string; headingId?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-subtle text-ink-muted">
        <CircleSlash className="size-6" aria-hidden />
      </span>
      <h2
        id={headingId}
        tabIndex={headingId ? -1 : undefined}
        className="mt-4 text-base font-semibold text-ink focus:outline-none"
      >
        This role is no longer accepting applications.
      </h2>
      <p className="mt-1 text-sm wrap-break-word text-ink-muted">Thanks for your interest in {companyName}.</p>
    </div>
  );
}
