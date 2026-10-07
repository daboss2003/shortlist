import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readFormDataWithLimit } from "./body-limit";

async function multipart(fields: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = new Response(fd);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type")! };
}

/** A request whose body arrives in chunks with no Content-Length, like a chunked upload. */
function chunkedRequest(bytes: Uint8Array, contentType: string) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.subarray(i, i + 1024));
      controller.close();
    },
  });
  return new Request("http://localhost/upload", {
    method: "POST",
    body,
    headers: { "content-type": contentType },
    duplex: "half",
  } as RequestInit);
}

describe("readFormDataWithLimit", () => {
  it("parses a body within the limit", async () => {
    const { bytes, contentType } = await multipart({ name: "Ada", cv: new File(["hello"], "cv.txt") });
    const form = await readFormDataWithLimit(chunkedRequest(bytes, contentType), 10_000);
    expect(form.get("name")).toBe("Ada");
    expect(await (form.get("cv") as File).text()).toBe("hello");
  });

  it("rejects an oversized chunked body that declares no Content-Length", async () => {
    const { bytes, contentType } = await multipart({ cv: new File(["x".repeat(50_000)], "cv.txt") });
    const req = chunkedRequest(bytes, contentType);
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readFormDataWithLimit(req, 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("rejects early when the declared Content-Length is over the limit", async () => {
    const { bytes, contentType } = await multipart({ name: "Ada" });
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: bytes,
      headers: { "content-type": contentType, "content-length": "999999" },
    });
    await expect(readFormDataWithLimit(req, 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
