import { describe, expect, it } from "vitest";
import { safeFileStem } from "./file-name";

describe("safeFileStem", () => {
  it("keeps ASCII letters, digits and dashes, capped at 60", () => {
    expect(safeFileStem("Zoë O'Brien / 王")).toBe("Zoe-O-Brien");
    expect(safeFileStem("José Álvarez-Núñez")).toBe("Jose-Alvarez-Nunez");
    expect(safeFileStem("王小明")).toBe("candidate");
    expect(safeFileStem("王小明", "job")).toBe("job");
    expect(safeFileStem("a".repeat(80))).toHaveLength(60);
    expect(safeFileStem(`${"a".repeat(59)} b`)).toBe("a".repeat(59));
  });
});
