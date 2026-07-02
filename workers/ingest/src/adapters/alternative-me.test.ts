import { describe, expect, it } from "vitest";
import { parseFearGreed } from "./alternative-me.js";

describe("parseFearGreed", () => {
  it("converts unix-seconds timestamp to epoch ms and coerces value", () => {
    const parsed = parseFearGreed({
      data: [{ value: "63", value_classification: "Greed", timestamp: "1751500800" }]
    });
    expect(parsed).toEqual({ ts: 1751500800000, value: 63, classification: "Greed" });
  });

  it("throws on an empty data array (DQ-04 territory — caller enqueues a retry)", () => {
    expect(() => parseFearGreed({ data: [] })).toThrow();
  });
});
