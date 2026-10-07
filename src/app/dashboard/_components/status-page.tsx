import type { ReactNode } from "react";
import { Wordmark } from "./wordmark";

/** Calm full-page message with the logo: the root 404 and error pages. */
export function StatusPage({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center sm:px-6">
      <Wordmark href="/" />
      <p className="mt-12 text-sm font-medium text-brand-ink tabular-nums">{eyebrow}</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-balance text-ink sm:text-3xl">{title}</h1>
      <p className="mt-3 max-w-md text-base text-pretty text-ink-muted">{description}</p>
      <div className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">{actions}</div>
    </main>
  );
}
