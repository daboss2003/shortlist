// Browser-only helpers for client components (fetch, Blob URLs; saveBlob also needs the DOM).

export type DownloadFailure = {
  ok: false;
  /** Lets callers show the sign-in message instead of "Couldn't …". */
  sessionExpired: boolean;
  /** User-facing. */
  error: string;
  /** HTTP status, or 0 when the request never got a response. */
  status: number;
};

export type DownloadOutcome = { ok: true; fileName: string } | DownloadFailure;

export type FetchFileOutcome = { ok: true; blob: Blob; fileName: string | null } | DownloadFailure;

/** Prefers the exact UTF-8 name (RFC 5987 `filename*`), then the plain `filename`. */
export function fileNameFrom(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // Malformed encoding: fall back to the ASCII name.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(header)?.[1];
  return plain?.trim() || null;
}

/** Turns a failed response into a user-facing message, preferring the server's JSON `error`. */
export async function failureFrom(res: Response): Promise<DownloadFailure> {
  if (res.status === 401) {
    return { ok: false, sessionExpired: true, error: "Your session expired — log in again.", status: 401 };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const error =
    typeof body?.error === "string" && body.error
      ? body.error
      : res.status >= 500
        ? "Something went wrong on our side. Try again."
        : "The request wasn't accepted. Reload the page and try again.";
  return { ok: false, sessionExpired: false, error, status: res.status };
}

const INTERRUPTED: DownloadFailure = {
  ok: false,
  sessionExpired: false,
  error: "The download was interrupted. Check your connection and try again.",
  status: 0,
};

/** Fetches a file into memory. Failures come back as a message instead of a JSON error body posing as the file. */
export async function fetchFile(url: string, init?: RequestInit): Promise<FetchFileOutcome> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    if (!res.ok) return await failureFrom(res);
    const blob = await res.blob();
    return { ok: true, blob, fileName: fileNameFrom(res.headers.get("content-disposition")) };
  } catch {
    return INTERRUPTED;
  }
}

/** Saves a Blob through a temporary link, as if the user had downloaded it. */
export function saveBlob(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Intentional: revoked after a delay, not immediately — some browsers (older Safari/Firefox) cancel a
  // download whose blob URL is revoked in the same task as the click.
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Fetches a file and saves it under the server's file name. */
export async function downloadFile(url: string, init: RequestInit | undefined, fallbackName: string): Promise<DownloadOutcome> {
  const outcome = await fetchFile(url, init);
  if (!outcome.ok) return outcome;
  const fileName = outcome.fileName ?? fallbackName;
  saveBlob(outcome.blob, fileName);
  return { ok: true, fileName };
}
