import type { ReactNode } from "react";
import { Wordmark } from "@/app/dashboard/_components/wordmark";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex w-full max-w-md flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Wordmark href="/" />
          <p className="text-sm text-ink-muted">Share one link. Get every CV ranked against the role.</p>
        </div>
        {children}
      </div>
    </div>
  );
}
