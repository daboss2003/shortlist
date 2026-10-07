import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

const textLinkClass =
  "rounded-sm font-medium text-brand-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: { prompt: string; href: string; label: string };
}) {
  return (
    <div className="space-y-6">
      <Card className="px-6 py-8 sm:px-8">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
        <div className="mt-6">{children}</div>
      </Card>
      <p className="text-center text-sm text-ink-muted">
        {footer.prompt}{" "}
        <Link href={footer.href} className={textLinkClass}>
          {footer.label}
        </Link>
      </p>
    </div>
  );
}
