import { LogOut } from "lucide-react";
import { logoutAction } from "@/app/(auth)/actions";
import { requireEmployer } from "@/lib/auth/dal";
import { SubmitButton } from "./submit-button";

/** Company + user name and Sign out. Reads the session, so it must render inside <Suspense>. */
export async function UserMenu() {
  const employer = await requireEmployer();
  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-3">
      <div className="min-w-0 text-right leading-tight">
        <p className="max-w-28 truncate text-sm font-medium text-ink sm:max-w-56" title={employer.companyName}>
          {employer.companyName}
        </p>
        <p className="hidden max-w-56 truncate text-xs text-ink-muted sm:block" title={employer.email}>
          {employer.name}
        </p>
      </div>
      <form action={logoutAction}>
        <SubmitButton variant="ghost" size="sm" pendingLabel={<span className="sr-only sm:not-sr-only">Signing out…</span>}>
          <LogOut aria-hidden />
          <span className="sr-only sm:not-sr-only">Sign out</span>
        </SubmitButton>
      </form>
    </div>
  );
}

export function UserMenuSkeleton() {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <div className="hidden space-y-1.5 sm:block">
        <div className="ml-auto h-3 w-28 animate-pulse rounded bg-subtle" />
        <div className="ml-auto h-2.5 w-20 animate-pulse rounded bg-subtle" />
      </div>
      <div className="h-8 w-9 animate-pulse rounded-lg bg-subtle sm:w-24" />
    </div>
  );
}
