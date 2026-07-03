import { describe, expect, it } from "vitest";
import { parseFundingRate, parseOkxCandles, parseOpenInterest, type OkxCandleRaw } from "./okx.js";

describe("parseOkxCandles (docs/03 §7 pure-parse contract)", () => {
  it("reverses OKX's newest-first order and keeps only closed bars", () => {
    // OKX returns newest-first; last element here is the oldest closed bar.
    const raw: OkxCandleRaw[] = [
      ["1120", "101.5", "103.0", "101.0", "102.5", "8.0", "820.0", "820.0", "0"], // unclosed (newest)
      ["1060", "100.5", "102.0", "100.0", "101.5", "12.0", "1218.0", "1218.0", "1"],
      ["1000", "100.0", "101.0", "99.0", "100.5", "10.0", "1005.0", "1005.0", "1"]
    ];
    const rows = parseOkxCandles(raw, "BTCUSDT.BINANCE.PERP");
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
      taker_buy_volume: null,
      trades: null
    });
    expect(rows[1]?.ts).toBe(1060);
  });

  it("returns an empty array when every candle is still unclosed", () => {
    const raw: OkxCandleRaw[] = [["1000", "100.0", "101.0", "99.0", "100.5", "10.0", "1005.0", "1005.0", "0"]];
    expect(parseOkxCandles(raw, "BTCUSDT.BINANCE.PERP")).toHaveLength(0);
  });
});

describe("parseFundingRate", () => {
  it("coerces string numerics to numbers", () => {
    expect(parseFundingRate({ data: [{ instId: "BTC-USDT-SWAP", fundingRate: "0.00012", fundingTime: "1700000000000" }] })).toEqual({
      rate: 0.00012,
      ts: 1_700_000_000_000
    });
  });

  it("returns null when there is no data", () => {
    expect(parseFundingRate({ data: [] })).toBeNull();
  });
});

describe("parseOpenInterest", () => {
  it("coerces open interest to a number", () => {
    expect(parseOpenInterest({ data: [{ instId: "BTC-USDT-SWAP", oi: "45123.7", ts: "123" }] })).toEqual({
      oiBase: 45123.7,
      ts: 123
    });
  });

  it("returns null when there is no data", () => {
    expect(parseOpenInterest({ data: [] })).toBeNull();
  });
});
