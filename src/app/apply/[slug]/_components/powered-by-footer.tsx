import { APP_NAME } from "@/lib/brand";

export function PoweredByFooter() {
  return (
    <footer className="border-t border-line">
      <p className="mx-auto w-full max-w-5xl px-4 py-6 text-center text-xs text-ink-muted sm:px-6 lg:px-8">
        Powered by {APP_NAME}
      </p>
    </footer>
  );
}
