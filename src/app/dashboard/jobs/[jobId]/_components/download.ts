// Browser-only helper for client components (uses fetch, Blob URLs and the DOM).

export type DownloadOutcome =
  | { ok: true; fileName: string }
  /** `error` is user-facing. `sessionExpired` lets callers show the sign-in message instead of "Couldn't …". */
  | { ok: false; sessionExpired: boolean; error: string };

/** Prefers the exact UTF-8 name (RFC 5987 `filename*`), then the plain `filename`. */
function fileNameFrom(header: string | null): string | null {
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

/**
 * Fetches a file and saves it under the server's file name. Failures come back as a message instead of
 * the browser silently saving the JSON error body as a file.
 */
export async function downloadFile(url: string, init: RequestInit | undefined, fallbackName: string): Promise<DownloadOutcome> {
  let res: Response;
  let blob: Blob;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
    if (res.status === 401) return { ok: false, sessionExpired: true, error: "Your session expired — log in again." };
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const error =
        typeof body?.error === "string" && body.error
          ? body.error
          : res.status >= 500
            ? "Something went wrong on our side. Try again."
            : "The request wasn't accepted. Reload the page and try again.";
      return { ok: false, sessionExpired: false, error };
    }
    blob = await res.blob();
  } catch {
    return { ok: false, sessionExpired: false, error: "The download was interrupted. Check your connection and try again." };
  }

  const fileName = fileNameFrom(res.headers.get("content-disposition")) ?? fallbackName;
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
  return { ok: true, fileName };
}
