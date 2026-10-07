"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";

export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card>
      <EmptyState
        icon={<TriangleAlert />}
        title="Something went wrong"
        description="We couldn't load this page. Try again — if it keeps happening, go back to your jobs."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => retry()}>
              <RotateCw aria-hidden />
              Try again
            </Button>
            <ButtonLink href="/dashboard" variant="secondary">
              Back to jobs
            </ButtonLink>
          </div>
        }
      />
    </Card>
  );
}
