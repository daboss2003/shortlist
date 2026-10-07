import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge, isRetryingBusyAi } from "./badges";

const BUSY = "The AI service is busy — this CV will be retried automatically.";
const render = (props: Parameters<typeof StatusBadge>[0]) => renderToStaticMarkup(createElement(StatusBadge, props));

describe("StatusBadge", () => {
  it("shows a pending CV with a busy note as Retrying, in the warning tone, with the note on hover", () => {
    const html = render({ status: "pending", error: BUSY });
    expect(html).toContain("Retrying");
    expect(html).toContain("text-warning");
    expect(html).toContain(`title="${BUSY}"`);
    expect(html).not.toContain("Queued");
  });

  it("keeps a plain pending CV Queued, with no title", () => {
    for (const error of [null, undefined, ""]) {
      const html = render({ status: "pending", error });
      expect(html).toContain("Queued");
      expect(html).not.toContain("Retrying");
      expect(html).not.toContain("title=");
    }
  });

  it("shows only a failed CV's error on hover; other states never say Retrying", () => {
    expect(render({ status: "failed", error: "Broken" })).toContain('title="Broken"');
    expect(render({ status: "processing", error: "stale" })).not.toMatch(/title=|Retrying/);
    expect(render({ status: "ready", error: "stale" })).not.toMatch(/title=|Retrying/);
  });
});

describe("isRetryingBusyAi", () => {
  it("is a pending CV that carries a note", () => {
    expect(isRetryingBusyAi("pending", BUSY)).toBe(true);
    expect(isRetryingBusyAi("pending", null)).toBe(false);
    expect(isRetryingBusyAi("failed", BUSY)).toBe(false);
    expect(isRetryingBusyAi("processing", BUSY)).toBe(false);
  });
});
