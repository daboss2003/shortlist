import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
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
      <BrandMark className="shadow-xs rounded-lg" />
      <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
    </Link>
  );
}
