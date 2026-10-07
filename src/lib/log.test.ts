import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { candidates } from "@/db/schema";
import { describeError, withSafeErrors } from "./log";

const SECRET = "SECRET-CV-TEXT jane.private@example.com";

/** A real failed query whose parameters include SECRET (the job doesn't exist: a foreign-key violation). */
async function failingQuery(): Promise<unknown> {
  return db
    .insert(candidates)
    .values({
      jobId: "no-such-job",
      companyId: "no-such-company",
      source: "upload",
      cvFileKey: `${crypto.randomUUID()}.txt`,
      cvFileName: "cv.txt",
      cvMimeType: "text/plain",
      cvSize: 1,
      cvText: SECRET,
    })
    .then(
      () => {
        throw new Error("expected the insert to fail");
      },
      (err: unknown) => err,
    );
}

describe("describeError", () => {
  it("keeps the database's reason but never the query's parameters, with or without the stack", async () => {
    const err = await failingQuery();
    // The premise: drizzle's own message does carry the parameters.
    expect(String((err as Error).message)).toContain(SECRET);

    for (const text of [describeError(err), describeError(err, { withStack: true })]) {
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("jane.private");
      expect(text).toMatch(/^database query failed: .*foreign key/);
    }
  });

  it("finds a query error wrapped as another error's cause", async () => {
    const wrapped = new Error("could not save", { cause: await failingQuery() });
    expect(describeError(wrapped, { withStack: true })).not.toContain("SECRET");
  });

  it("describes other errors by message, or by stack when asked", () => {
    const err = new TypeError("x is not a function");
    expect(describeError(err)).toBe("x is not a function");
    expect(describeError(err, { withStack: true })).toContain("TypeError: x is not a function\n    at ");
    expect(describeError("plain string")).toBe("plain string");
  });
});

describe("withSafeErrors", () => {
  it("rethrows a failed query without its parameters in the message or the stack", async () => {
    const err = (await withSafeErrors(async () => {
      throw await failingQuery();
    }).catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^database query failed: /);
    expect(`${err.message}\n${err.stack}`).not.toContain("SECRET");
    expect(err.cause).toBeUndefined();
  });

  it("passes results and other errors through untouched", async () => {
    expect(await withSafeErrors(async () => 42)).toBe(42);
    const original = Object.assign(new Error("CV file not found"), { code: "ENOENT" });
    await expect(
      withSafeErrors(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});
