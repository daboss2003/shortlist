export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
  }
}

/**
 * Parses a multipart/urlencoded body, aborting as soon as more than `maxBytes` have arrived. Unlike a
 * Content-Length check alone, this also bounds chunked bodies (no Content-Length) — Route Handlers have no
 * framework body limit, so without this a client can stream until the process runs out of memory.
 */
export async function readFormDataWithLimit(request: Request, maxBytes: number): Promise<FormData> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return request.formData();

  let received = 0;
  const limited = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) controller.error(new BodyTooLargeError());
        else controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(limited, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch (err) {
    if (received > maxBytes) throw new BodyTooLargeError();
    throw err;
  }
}
