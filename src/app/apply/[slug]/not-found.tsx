import { Link2Off } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PoweredByFooter } from "./_components/powered-by-footer";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col bg-canvas">
      <main className="flex flex-1 items-center justify-center px-4 py-16 sm:px-6">
        <Card className="w-full max-w-md">
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-subtle text-ink-muted">
              <Link2Off className="size-6" aria-hidden />
            </span>
            <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">This job link isn&apos;t valid</h1>
            <p className="mt-2 text-base leading-7 text-ink-muted">
              The link may be mistyped, or the role may have been removed. Check with the company that shared it.
            </p>
          </div>
        </Card>
      </main>
      <PoweredByFooter />
    </div>
  );
}
