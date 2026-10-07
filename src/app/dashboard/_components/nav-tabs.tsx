import Link from "next/link";
import { cn } from "@/lib/cn";

export type NavSection = "jobs" | "settings" | "admin";

const ITEMS: { section: NavSection; href: string; label: string; adminOnly?: boolean }[] = [
  { section: "jobs", href: "/dashboard", label: "Jobs" },
  { section: "settings", href: "/dashboard/settings", label: "Settings" },
  { section: "admin", href: "/dashboard/admin/invites", label: "Invites", adminOnly: true },
];

/** Dashboard section tabs. `active` null renders none highlighted (used while the session loads). */
export function NavTabs({ active, isAdmin }: { active: NavSection | null; isAdmin: boolean }) {
  return (
    <>
      {ITEMS.filter((item) => isAdmin || !item.adminOnly).map((item) => {
        const current = item.section === active;
        return (
          <Link
            key={item.section}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "flex h-full items-center border-b-2 px-1 pt-0.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand",
              current
                ? "border-brand text-ink"
                : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
