"use client";

import { useEffect, useTransition } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/feedback";
import { PoweredByFooter } from "./_components/powered-by-footer";

export default function ApplyError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // retry() re-fetches the page in a transition; tracking it shows the click registered while it loads.
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col bg-canvas">
      <main className="flex flex-1 items-center justify-center px-4 py-16 sm:px-6">
        <Card className="w-full max-w-md">
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-subtle text-ink-muted">
              <CircleAlert className="size-6" aria-hidden />
            </span>
            <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">Something went wrong loading this job.</h1>
            <p className="mt-2 text-base leading-7 text-ink-muted">Please try again in a moment.</p>
            <Button
              size="lg"
              disabled={retrying}
              onClick={() => startRetry(() => retry())}
              className="mt-6 [&_svg]:text-white"
            >
              {retrying ? (
                <>
                  <Spinner label="Trying again" />
                  Trying again…
                </>
              ) : (
                <>
                  <RotateCw aria-hidden />
                  Try again
                </>
              )}
            </Button>
          </div>
        </Card>
      </main>
      <PoweredByFooter />
    </div>
  );
}
