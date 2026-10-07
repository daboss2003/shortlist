"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const AnnounceContext = createContext<(message: string) => void>(() => {});

/**
 * The view's single, always-present polite live region. Client components below it report action
 * outcomes with `useAnnounce()` instead of rendering their own live regions.
 */
export function Announcer({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState({ id: 0, text: "" });
  const announce = useCallback((text: string) => setMessage((prev) => ({ id: prev.id + 1, text })), []);

  return (
    <AnnounceContext value={announce}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {/* Keyed so repeating the same message ("2 candidates shortlisted" twice) is still read out. */}
        <span key={message.id}>{message.text}</span>
      </div>
    </AnnounceContext>
  );
}

export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext);
}
