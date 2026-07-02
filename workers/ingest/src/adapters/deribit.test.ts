import { describe, expect, it } from "vitest";
import { parseDvol } from "./deribit.js";

describe("parseDvol", () => {
  it("floors the timestamp to the enclosing hour and takes the last close", () => {
    const parsed = parseDvol({
      result: {
        data: [
          [1_700_000_000_000, 50, 52, 49, 51],
          [1_700_003_600_000 + 123_456, 51, 53, 50, 52.5]
        ]
      }
    });
    expect(parsed.close).toBe(52.5);
    expect(parsed.hourTs % 3_600_000).toBe(0);
  });

  it("throws when the API returns no points", () => {
    expect(() => parseDvol({ result: { data: [] } })).toThrow();
  });
});
