"use client";

import { useLayoutEffect, useState } from "react";

/**
 * False once the page has been hidden after `state` arrived. Cache Components keeps visited pages mounted
 * (hidden by React Activity), so an action's one-time result — "Saved", a freshly created invite link — would
 * otherwise still be on screen when the user comes back later.
 */
export function useFreshResult<T>(state: T): boolean {
  const [hiddenState, setHiddenState] = useState<T | null>(null);
  // Layout-effect cleanup runs synchronously when Activity hides the page (and when `state` changes,
  // which is harmless: the new state is never the hidden one).
  useLayoutEffect(() => () => setHiddenState(state), [state]);
  return hiddenState !== state;
}
