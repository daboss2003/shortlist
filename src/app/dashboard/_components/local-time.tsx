"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const OPTIONS = { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const;
const utcFormat = new Intl.DateTimeFormat("en", { ...OPTIONS, timeZone: "UTC" });

/**
 * A time in the viewer's own time zone, e.g. "Thu 1:00 AM GMT+1". The server doesn't know that zone, so it
 * renders UTC and the browser swaps in local time right after hydration.
 */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => new Intl.DateTimeFormat(undefined, OPTIONS).format(new Date(iso)),
    () => utcFormat.format(new Date(iso)),
  );
  return <time dateTime={iso}>{text}</time>;
}
