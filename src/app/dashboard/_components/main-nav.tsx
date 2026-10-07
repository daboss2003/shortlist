"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import { NavTabs, type NavSection } from "./nav-tabs";

function sectionFor(segment: string | null): NavSection | null {
  if (segment === null || segment === "jobs") return "jobs";
  if (segment === "settings" || segment === "admin") return segment;
  return null;
}

/** Section tabs with the current one marked. Render inside <Suspense>: the segment can be request-time data. */
export function MainNav({ isAdmin }: { isAdmin: boolean }) {
  return <NavTabs active={sectionFor(useSelectedLayoutSegment())} isAdmin={isAdmin} />;
}
