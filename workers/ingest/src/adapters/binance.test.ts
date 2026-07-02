import { describe, expect, it } from "vitest";
import { parseFundingSnapshot, parseKlines1m, parseOpenInterest, type RawKline } from "./binance.js";

describe("parseKlines1m (docs/03 §7 pure-parse contract)", () => {
  it("drops the last (unclosed) candle and maps fields correctly", () => {
    const raw: RawKline[] = [
      [1000, "100.0", "101.0", "99.0", "100.5", "10.0", 1059, "1005.0", 20, "6.0", "603.0", "0"],
      [1060, "100.5", "102.0", "100.0", "101.5", "12.0", 1119, "1218.0", 25, "7.0", "710.0", "0"],
      [1120, "101.5", "103.0", "101.0", "102.5", "8.0", 1179, "820.0", 15, "3.0", "307.5", "0"] // unclosed
    ];
    const rows = parseKlines1m(raw, "BTCUSDT.BINANCE.PERP");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      instrument_id: "BTCUSDT.BINANCE.PERP",
      tf: "1m",
      ts: 1000,
      open: 100.0,
      high: 101.0,
      low: 99.0,
      close: 100.5,
      volume: 10.0,
      quote_volume: 1005.0,
      taker_buy_volume: 6.0,
      trades: 20
    });
    expect(rows[1]?.ts).toBe(1060);
  });

  it("returns an empty array when Binance returns only the unclosed candle", () => {
    const raw: RawKline[] = [
      [1000, "100.0", "101.0", "99.0", "100.5", "10.0", 1059, "1005.0", 20, "6.0", "603.0", "0"]
    ];
    expect(parseKlines1m(raw, "BTCUSDT.BINANCE.PERP")).toHaveLength(0);
  });
});

describe("parseFundingSnapshot", () => {
  it("coerces string numerics to numbers", () => {
    const parsed = parseFundingSnapshot({
      symbol: "BTCUSDT",
      markPrice: "65000.12",
      lastFundingRate: "0.00012",
      nextFundingTime: 1_700_000_000_000,
      time: 1_699_999_000_000
    });
    expect(parsed).toEqual({
      rate: 0.00012,
      markPrice: 65000.12,
      nextFundingTime: 1_700_000_000_000,
      ts: 1_699_999_000_000
    });
  });
});

describe("parseOpenInterest", () => {
  it("coerces open interest to a number", () => {
    expect(parseOpenInterest({ symbol: "BTCUSDT", openInterest: "45123.7", time: 123 })).toEqual({
      oiBase: 45123.7,
      ts: 123
    });
  });
});
