import { describe, expect, it } from "vitest";
import { formatSnapshotValue, formatUtcTimestamp } from "./format";

describe("formatSnapshotValue", () => {
  it("formats funding keys as a signed percentage with 4 decimals", () => {
    expect(formatSnapshotValue("funding:binance:BTCUSDT", 0.00012)).toBe("0.0120%");
  });

  it("formats candle/oi keys with locale grouping", () => {
    expect(formatSnapshotValue("candle:1m:BTCUSDT.BINANCE.PERP", 65000)).toBe("65,000");
    expect(formatSnapshotValue("oi:binance:BTCUSDT", 12345)).toBe("12,345");
  });

  it("falls back to a plain string for unrecognized keys", () => {
    expect(formatSnapshotValue("dvol:BTC", 51.2)).toBe("51.2");
  });
});

describe("formatUtcTimestamp", () => {
  it("renders 'YYYY-MM-DD HH:MM UTC'", () => {
    expect(formatUtcTimestamp(Date.parse("2026-07-02T21:05:30Z"))).toBe("2026-07-02 21:05 UTC");
  });
});
