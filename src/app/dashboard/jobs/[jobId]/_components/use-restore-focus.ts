import { useCallback, useEffect, useRef } from "react";

type FocusTarget = string | (() => HTMLElement | null | undefined);

/**
 * For when the focused control unmounts (a confirm step closes, a toolbar swaps its buttons): call the
 * returned function with element ids (or getters) and the first one that exists is focused after the next
 * render in which `ready` is true (e.g. once buttons are re-enabled). Only lost focus is rescued — if the
 * user has moved focus somewhere else in the meantime, it's left there.
 */
export function useRestoreFocus(ready = true): (...targets: FocusTarget[]) => void {
  const request = useRef<FocusTarget[] | null>(null);

  useEffect(() => {
    const targets = request.current;
    if (!targets || !ready) return;
    request.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    for (const target of targets) {
      const el = typeof target === "string" ? document.getElementById(target) : target();
      if (el) {
        el.focus();
        return;
      }
    }
  });

  return useCallback((...targets: FocusTarget[]) => {
    request.current = targets;
  }, []);
}
