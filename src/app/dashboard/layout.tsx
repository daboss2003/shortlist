import Link from "next/link";
import { Suspense } from "react";
import { UserMenu, UserMenuSkeleton } from "./_components/user-menu";
import { Wordmark } from "./_components/wordmark";

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:gap-8 sm:px-6 lg:px-8">
          <Wordmark href="/dashboard" />
          <nav aria-label="Main" className="flex h-full items-center">
            {/* Intentional: Jobs is the only section and every dashboard page lives under it, so it's always the active tab. */}
            <Link
              href="/dashboard"
              className="flex h-full items-center border-b-2 border-brand px-1 pt-0.5 text-sm font-medium text-ink transition-colors hover:text-brand-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
            >
              Jobs
            </Link>
          </nav>
          <div className="ml-auto flex min-w-0 justify-end">
            <Suspense fallback={<UserMenuSkeleton />}>
              <UserMenu />
            </Suspense>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </>
  );
}
