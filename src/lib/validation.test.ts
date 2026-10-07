import { describe, expect, it } from "vitest";
import { INVALID_CHARACTER, hasNul, safeText } from "./validation";

describe("safeText", () => {
  it("accepts ordinary text, including other control characters and non-ASCII", () => {
    expect(safeText().safeParse("Jane Doe").success).toBe(true);
    expect(safeText().safeParse("Line one\nLine two\tTabbed").success).toBe(true);
    expect(safeText().safeParse("José Álvarez 工程师").success).toBe(true);
    expect(safeText().safeParse("").success).toBe(true);
  });

  it("rejects a NUL anywhere with a field message instead of throwing", () => {
    for (const value of ["\u0000", "Jane\u0000Doe", "Jane Doe\u0000", "\u0000Jane"]) {
      const result = safeText().safeParse(value);
      expect(result.success, JSON.stringify(value)).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(INVALID_CHARACTER);
    }
  });

  it("chains like z.string(), and still reports the NUL when other checks pass", () => {
    const schema = safeText().trim().min(1, "Required.").max(5, "Too long.");
    expect(schema.parse("  abc  ")).toBe("abc");
    expect(schema.safeParse("   ").error?.issues[0]?.message).toBe("Required.");
    expect(schema.safeParse(" a\u0000b ").error?.issues.map((i) => i.message)).toEqual([INVALID_CHARACTER]);
  });

  it("passes its params to z.string(), e.g. the message for a missing value", () => {
    expect(safeText({ error: "Enter a name." }).safeParse(undefined).error?.issues[0]?.message).toBe("Enter a name.");
  });
});

describe("hasNul", () => {
  it("detects U+0000 only", () => {
    expect(hasNul("a\u0000b")).toBe(true);
    expect(hasNul("a\\u0000b")).toBe(false);
    expect(hasNul("a\u0001b")).toBe(false);
  });
});
