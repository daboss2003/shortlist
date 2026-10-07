"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useAnnounce } from "./announcer";

const subscribe = () => () => {};
const getOrigin = () => window.location.origin;
// Intentional: the server renders the path only; the origin fills in after hydration (no mismatch).
const getServerOrigin = () => "";

export function ShareLink({ slug }: { slug: string }) {
  const origin = useSyncExternalStore(subscribe, getOrigin, getServerOrigin);
  const announce = useAnnounce();
  const path = `/apply/${slug}`;
  const url = `${origin}${path}`;

  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopyState("copied");
      announce("Application link copied");
      timer.current = window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      // Clipboard API is unavailable on insecure origins or when permission is denied.
      inputRef.current?.select();
      setCopyState("manual");
      announce("Couldn't copy automatically. The link is selected — copy it with your keyboard.");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="application-link" className="sr-only">
          Public application link
        </label>
        <Input
          id="application-link"
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 font-mono text-xs sm:flex-1"
        />
        <div className="flex gap-2">
          <Button variant="secondary" onClick={copy} className="flex-1 sm:flex-none">
            {copyState === "copied" ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
            {copyState === "copied" ? "Copied" : "Copy"}
          </Button>
          <a
            href={path}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass("ghost", "md", "flex-1 sm:flex-none")}
          >
            <ExternalLink aria-hidden />
            Open
          </a>
        </div>
      </div>
      {copyState === "manual" && (
        <p className="text-sm text-ink-muted">Couldn&apos;t copy automatically — the link is selected, press Ctrl+C (⌘C on Mac).</p>
      )}
    </div>
  );
}
