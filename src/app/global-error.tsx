"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";
import { StatusPage } from "./dashboard/_components/status-page";
import "./globals.css";

// Replaces the root layout when it fails, so it brings its own document and styles.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      {/* Intentional: system font stack inline — the Geist font variables come from the root layout, which isn't rendered here. */}
      <body className="flex min-h-full flex-col" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <title>{`Something went wrong · ${APP_NAME}`}</title>
        <StatusPage
          eyebrow="Error"
          title="Something went wrong"
          description={`${APP_NAME} couldn't load. Try again in a moment.`}
          actions={
            <Button size="lg" onClick={() => retry()}>
              <RotateCw aria-hidden />
              Try again
            </Button>
          }
        />
      </body>
    </html>
  );
}
