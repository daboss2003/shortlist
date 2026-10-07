"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { StatusPage } from "./dashboard/_components/status-page";

export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      eyebrow="Error"
      title="Something went wrong"
      description="This page didn't load properly. Try again in a moment."
      actions={
        <>
          <Button size="lg" onClick={() => retry()}>
            <RotateCw aria-hidden />
            Try again
          </Button>
          <ButtonLink href="/" variant="secondary" size="lg">
            Go to the homepage
          </ButtonLink>
        </>
      }
    />
  );
}
