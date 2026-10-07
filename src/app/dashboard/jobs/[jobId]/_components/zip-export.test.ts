import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZipManifest, ZipManifestEntry } from "@/app/api/jobs/[jobId]/export/route";
import { ZIP_TOO_LARGE_MESSAGE } from "./build-zip";
import { prepareCvZip, spreadsheetRequest, type ExportRequest } from "./zip-export";

const BASE = "backend-candidates-2026-10-07";
const CV_URL = /^\/api\/candidates\/([^/]+)\/cv$/;

const entry = (i: number, overrides: Partial<ZipManifestEntry> = {}): ZipManifestEntry => ({
  id: `0000000${i}-0000-4000-8000-000000000000`,
  rank: i,
  name: `Person ${i}`,
  cvFileName: `person-${i}.pdf`,
  cvExt: "pdf",
  cvSize: 1000,
  ...overrides,
});

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

let handler: Handler;
let calls: Array<{ url: string; method: string; fields: URLSearchParams; body: Record<string, string> | null }>;
let cvInFlight: number;
let maxCvInFlight: number;

/** An export request's fields: the query string, overlaid with a URLSearchParams body (as the route reads a POST). */
function fieldsOf(url: string, init: RequestInit | undefined): URLSearchParams {
  const fields = new URLSearchParams(new URL(url, "http://localhost").search);
  if (init?.body instanceof URLSearchParams) for (const [k, v] of init.body) fields.set(k, v);
  return fields;
}

/** Answers the export formats from `manifest` and each CV with its id as content, unless `cv` says otherwise. */
function serve(manifest: ZipManifest, cv: (id: string, attempt: number) => Response | "network-error" = (id) => new Response(`%PDF ${id}`)) {
  const attempts = new Map<string, number>();
  handler = (url, init) => {
    const cvId = CV_URL.exec(url)?.[1];
    if (cvId) {
      const attempt = (attempts.get(cvId) ?? 0) + 1;
      attempts.set(cvId, attempt);
      const res = cv(cvId, attempt);
      if (res === "network-error") throw new TypeError("Failed to fetch");
      return res;
    }
    const format = fieldsOf(url, init).get("format");
    if (format === "manifest") return Response.json(manifest);
    if (format === "csv") return new Response("﻿Rank,Name\r\n", { headers: { "content-disposition": `attachment; filename="${BASE}.csv"` } });
    if (format === "xlsx") return new Response(new Uint8Array([0x50, 0x4b, 3, 4]));
    return Response.json({ error: "Unexpected request" }, { status: 400 });
  };
  return attempts;
}

const getRequest: ExportRequest = (format) => [`/api/jobs/job-1/export?format=${format}`];

beforeEach(() => {
  calls = [];
  cvInFlight = 0;
  maxCvInFlight = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", fields: fieldsOf(url, init), body });
      const isCv = CV_URL.test(url);
      if (isCv) maxCvInFlight = Math.max(maxCvInFlight, ++cvInFlight);
      try {
        // A tick of latency, so concurrent requests actually overlap.
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await handler(url, init);
      } finally {
        if (isCv) cvInFlight--;
      }
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prepareCvZip", () => {
  it("fetches the manifest, both spreadsheets and every CV (at most 3 at a time), and zips them by rank", async () => {
    const candidates = [...Array.from({ length: 7 }, (_, i) => entry(i + 1)), entry(8, { rank: null, cvExt: "docx" })];
    serve({ baseName: BASE, candidates });
    const progress: Array<[number, number]> = [];

    const result = await prepareCvZip(getRequest, (done, total) => progress.push([done, total]));

    expect(result).toMatchObject({ ok: true, fileName: `${BASE}.zip`, total: 8, missing: 0 });
    if (!result.ok) return;
    expect(progress).toEqual([[0, 8], ...Array.from({ length: 8 }, (_, i): [number, number] => [i + 1, 8])]);
    expect(maxCvInFlight).toBe(3);
    expect(calls.filter((c) => CV_URL.test(c.url))).toHaveLength(8);

    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const cvs = zip.file(/^cvs\//).map((f) => f.name);
    expect(cvs).toEqual([
      "cvs/001-Person-1.pdf",
      "cvs/002-Person-2.pdf",
      "cvs/003-Person-3.pdf",
      "cvs/004-Person-4.pdf",
      "cvs/005-Person-5.pdf",
      "cvs/006-Person-6.pdf",
      "cvs/007-Person-7.pdf",
      "cvs/unranked-00000008-Person-8.docx",
    ]);
    // Each CV landed under its own candidate's name, despite concurrent fetches finishing out of order.
    expect(await zip.file("cvs/004-Person-4.pdf")!.async("string")).toBe(`%PDF ${entry(4).id}`);
    expect(zip.file(`${BASE}.csv`)).not.toBeNull();
    expect(zip.file(`${BASE}.xlsx`)).not.toBeNull();
  });

  it("sends every export request for the same selection the caller describes (e.g. a POST of ids)", async () => {
    serve({ baseName: BASE, candidates: [entry(1)] });
    const postRequest: ExportRequest = (format) => [
      `/api/jobs/job-1/export?format=${format}`,
      { method: "POST", body: new URLSearchParams({ format, ids: entry(1).id }) },
    ];

    expect((await prepareCvZip(postRequest, () => {})).ok).toBe(true);
    expect(calls.filter((c) => c.url.startsWith("/api/jobs/")).map((c) => c.method)).toEqual(["POST", "POST", "POST"]);
  });

  it("asks for the spreadsheets of exactly the manifest's candidates, keeping the view's stage", async () => {
    const candidates = [entry(1), entry(2), entry(3, { rank: null })];
    serve({ baseName: BASE, candidates });
    const stageView: ExportRequest = (format) => [`/api/jobs/job-1/export?format=${format}&stage=shortlisted`];

    expect((await prepareCvZip(stageView, () => {})).ok).toBe(true);

    const exports = calls.filter((c) => c.url.startsWith("/api/jobs/"));
    expect(exports[0]).toMatchObject({ url: "/api/jobs/job-1/export?format=manifest&stage=shortlisted", method: "GET" });
    const sheets = exports.slice(1).sort((x, y) => x.fields.get("format")!.localeCompare(y.fields.get("format")!));
    for (const [call, format] of [
      [sheets[0], "csv"],
      [sheets[1], "xlsx"],
    ] as const) {
      expect(call.url).toBe("/api/jobs/job-1/export?for=zip");
      expect(call.method).toBe("POST");
      expect(call.body).toEqual({ format, stage: "shortlisted", ids: candidates.map((c) => c.id).join(",") });
    }
  });

  it("keeps a CV that arrives after the manifest out of the spreadsheets too", async () => {
    // A fake export endpoint over a job whose candidates change while the ZIP is being prepared.
    const people = [entry(1), entry(2)];
    const late = entry(3);
    handler = (url, init) => {
      const cvId = CV_URL.exec(url)?.[1];
      if (cvId) return new Response(`%PDF ${cvId}`);
      const fields = fieldsOf(url, init);
      const wanted = fields.get("ids")?.split(",");
      const rows = wanted ? people.filter((p) => wanted.includes(p.id)) : people;
      if (fields.get("format") === "manifest") {
        const manifest = Response.json({ baseName: BASE, candidates: rows });
        people.push(late);
        return manifest;
      }
      return new Response(`Rank,Name\r\n${rows.map((p) => `${p.rank},${p.name}`).join("\r\n")}\r\n`);
    };

    const result = await prepareCvZip(getRequest, () => {});

    expect(result).toMatchObject({ ok: true, total: 2, missing: 0 });
    if (!result.ok) return;
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(await zip.file(`${BASE}.csv`)!.async("string")).toBe("Rank,Name\r\n1,Person 1\r\n2,Person 2\r\n");
    expect(zip.file(/^cvs\//).map((f) => f.name)).toEqual(["cvs/001-Person-1.pdf", "cvs/002-Person-2.pdf"]);
  });

  it("sends the manifest's ids in one request even past a selection's 1000", async () => {
    const candidates = Array.from({ length: 1500 }, (_, i) => entry(i + 1, { id: crypto.randomUUID() }));
    serve({ baseName: BASE, candidates });

    expect((await prepareCvZip(getRequest, () => {})).ok).toBe(true);

    const sheets = calls.filter((c) => c.url.startsWith("/api/jobs/") && c.method === "POST");
    expect(sheets).toHaveLength(2);
    for (const call of sheets) expect(call.fields.get("ids")!.split(",")).toEqual(candidates.map((c) => c.id));
  });

  it("lists a gone CV (404) as missing without retrying, and retries a server error or dropped connection once", async () => {
    const [gone, flaky, down, fine] = [entry(1), entry(2), entry(3), entry(4)];
    const attempts = serve({ baseName: BASE, candidates: [gone, flaky, down, fine] }, (id, attempt) => {
      if (id === gone.id) return Response.json({ error: "The CV file is no longer available." }, { status: 404 });
      if (id === flaky.id && attempt === 1) return Response.json({ error: "boom" }, { status: 502 });
      if (id === down.id) return "network-error";
      return new Response(`%PDF ${id}`);
    });

    const result = await prepareCvZip(getRequest, () => {});

    expect(result).toMatchObject({ ok: true, total: 4, missing: 2 });
    expect(Object.fromEntries(attempts)).toEqual({ [gone.id]: 1, [flaky.id]: 2, [down.id]: 2, [fine.id]: 1 });
    if (!result.ok) return;
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(zip.file(/^cvs\//).map((f) => f.name)).toEqual(["cvs/002-Person-2.pdf", "cvs/004-Person-4.pdf"]);
    const missing = await zip.file("missing-files.txt")!.async("string");
    expect(missing).toContain("#1 — Person 1 (person-1.pdf)");
    expect(missing).toContain("#3 — Person 3 (person-3.pdf)");
  });

  it("stops at an expired session instead of listing every CV as missing", async () => {
    const candidates = Array.from({ length: 9 }, (_, i) => entry(i + 1));
    serve({ baseName: BASE, candidates }, (id) =>
      id === candidates[1].id ? Response.json({ error: "Your session has expired." }, { status: 401 }) : new Response("%PDF"),
    );

    const result = await prepareCvZip(getRequest, () => {});

    expect(result).toEqual({ ok: false, sessionExpired: true, error: "Your session expired — log in again.", status: 401 });
    // The requests already in flight finish, but no new CV is fetched after the 401.
    expect(calls.filter((c) => CV_URL.test(c.url)).length).toBeLessThanOrEqual(4);
  });

  it("passes on the server's error when the manifest is refused, fetching nothing else", async () => {
    handler = () => Response.json({ error: "No candidates to export." }, { status: 400 });
    const result = await prepareCvZip(getRequest, () => {});
    expect(result).toEqual({ ok: false, sessionExpired: false, error: "No candidates to export.", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("refuses an export over the size caps before fetching any file", async () => {
    serve({ baseName: BASE, candidates: [entry(1, { cvSize: 600 * 1024 ** 2 }), entry(2, { cvSize: 600 * 1024 ** 2 })] });
    const progress = vi.fn();

    const result = await prepareCvZip(getRequest, progress);

    expect(result).toMatchObject({ ok: false, sessionExpired: false, error: ZIP_TOO_LARGE_MESSAGE });
    expect(calls).toHaveLength(1);
    expect(progress).not.toHaveBeenCalled();
  });

  it("fails when a spreadsheet can't be fetched, before fetching any CV", async () => {
    serve({ baseName: BASE, candidates: [entry(1)] });
    const serveFormats = handler;
    handler = (url, init) =>
      fieldsOf(url, init).get("format") === "xlsx"
        ? Response.json({ error: "Something broke." }, { status: 500 })
        : serveFormats(url, init);

    const result = await prepareCvZip(getRequest, () => {});

    expect(result).toEqual({ ok: false, sessionExpired: false, error: "Something broke.", status: 500 });
    expect(calls.filter((c) => CV_URL.test(c.url))).toHaveLength(0);
  });

  it("reports an unexpected manifest as an error", async () => {
    handler = () => new Response("<html>not json</html>");
    expect(await prepareCvZip(getRequest, () => {})).toMatchObject({ ok: false, error: "The server sent an unexpected response. Try again." });
  });
});

describe("spreadsheetRequest", () => {
  it("turns a whole-view GET into a POST of the given ids, keeping its other fields", () => {
    const [url, init] = spreadsheetRequest((format) => [`/api/jobs/j/export?format=${format}&stage=rejected`], "xlsx", ["a", "b"]);
    expect(url).toBe("/api/jobs/j/export?for=zip");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ format: "xlsx", stage: "rejected", ids: "a,b" });
  });

  it("replaces a selection POST's ids with the given ones", () => {
    const selection: ExportRequest = (format) => [
      `/api/jobs/j/export`,
      { method: "POST", body: new URLSearchParams({ format, stage: "new", ids: "x,y,z" }) },
    ];
    const [url, init] = spreadsheetRequest(selection, "csv", ["y"]);
    expect(url).toBe("/api/jobs/j/export?for=zip");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ format: "csv", stage: "new", ids: "y" });
  });
});
