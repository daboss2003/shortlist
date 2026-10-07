import { Suspense } from "react";
import { getCurrentEmployer } from "@/lib/auth/dal";
import { MainNav } from "./_components/main-nav";
import { NavTabs } from "./_components/nav-tabs";
import { UserMenu, UserMenuSkeleton } from "./_components/user-menu";
import { Wordmark } from "./_components/wordmark";

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <>
      <header className="border-b border-line bg-surface">
        {/* Below sm the tabs wrap onto their own row under the logo and user menu. */}
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 px-4 sm:flex-nowrap sm:gap-x-8 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center">
            <Wordmark href="/dashboard" />
          </div>
          <nav aria-label="Main" className="order-last flex h-11 w-full items-center gap-5 sm:order-0 sm:h-14 sm:w-auto">
            <Suspense fallback={<NavTabs active={null} isAdmin={false} />}>
              <SessionNav />
            </Suspense>
          </nav>
          <div className="ml-auto flex h-14 min-w-0 items-center justify-end">
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

async function SessionNav() {
  const employer = await getCurrentEmployer();
  return <MainNav isAdmin={employer?.isPlatformAdmin === true} />;
}
