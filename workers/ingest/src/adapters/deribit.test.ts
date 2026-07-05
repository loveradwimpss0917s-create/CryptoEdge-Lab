import { describe, expect, it } from "vitest";
import { parseDvolPoints } from "./deribit.js";

describe("parseDvolPoints", () => {
  it("floors every point's timestamp to the enclosing hour", () => {
    const parsed = parseDvolPoints({
      result: {
        data: [
          [1_700_000_000_000, 50, 52, 49, 51],
          [1_700_003_600_000 + 123_456, 51, 53, 50, 52.5]
        ]
      }
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.close).toBe(51);
    expect(parsed[1]?.close).toBe(52.5);
    expect(parsed.every((p) => p.hourTs % 3_600_000 === 0)).toBe(true);
  });

  it("throws when the API returns no points", () => {
    expect(() => parseDvolPoints({ result: { data: [] } })).toThrow();
  });
});
