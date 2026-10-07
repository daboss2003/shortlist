import Link from "next/link";
import { ListFilter } from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/cn";

/** Product logo + name. Shared by the landing page, auth pages and the dashboard top bar. */
export function Wordmark({ href, className }: { href: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 rounded-lg text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand",
        className,
      )}
    >
      <span className="flex size-7 items-center justify-center rounded-lg bg-brand text-white shadow-xs">
        <ListFilter className="size-4" strokeWidth={2.5} aria-hidden />
      </span>
      <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
    </Link>
  );
}
