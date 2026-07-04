import { describe, expect, it } from "vitest";
import {
  parseFundingRate,
  parseLiquidationOrders,
  parseLongShortRatio,
  parseOkxCandles,
  parseOpenInterest,
  type OkxCandleRaw,
  type OkxLiquidationOrdersResponse,
  type OkxLongShortRatioResponse
} from "./okx.js";

describe("parseOkxCandles (docs/03 §7 pure-parse contract)", () => {
  it("reverses OKX's newest-first order and keeps only closed bars", () => {
    // OKX returns newest-first; last element here is the oldest closed bar.
    const raw: OkxCandleRaw[] = [
      ["1120", "101.5", "103.0", "101.0", "102.5", "8.0", "820.0", "820.0", "0"], // unclosed (newest)
      ["1060", "100.5", "102.0", "100.0", "101.5", "12.0", "1218.0", "1218.0", "1"],
      ["1000", "100.0", "101.0", "99.0", "100.5", "10.0", "1005.0", "1005.0", "1"]
    ];
    const rows = parseOkxCandles(raw, "BTCUSDT.BINANCE.SPOT", false);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      instrument_id: "BTCUSDT.BINANCE.SPOT",
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
    expect(parseOkxCandles(raw, "BTCUSDT.BINANCE.SPOT", false)).toHaveLength(0);
  });

  it("uses volCcy/volCcyQuote (not the raw contract-count vol) for futures instruments", () => {
    // vol=8.0 contracts, volCcy=0.08 BTC, volCcyQuote=5200 USDT — a futures
    // instrument should report base/quote volume, not contract count.
    const raw: OkxCandleRaw[] = [["1000", "100.0", "101.0", "99.0", "100.5", "8.0", "0.08", "5200", "1"]];
    const rows = parseOkxCandles(raw, "BTCUSDT.BINANCE.PERP", true);
    expect(rows[0]?.volume).toBe(0.08);
    expect(rows[0]?.quote_volume).toBe(5200);
  });
});

describe("parseFundingRate", () => {
  it("coerces string numerics to numbers and keeps fundingTime as nextFundingTime, not ts", () => {
    expect(
      parseFundingRate({ data: [{ instId: "BTC-USDT-SWAP", fundingRate: "0.00012", fundingTime: "1700000000000" }] })
    ).toEqual({
      rate: 0.00012,
      nextFundingTime: 1_700_000_000_000
    });
  });

  it("returns null when there is no data", () => {
    expect(parseFundingRate({ data: [] })).toBeNull();
  });
});

describe("parseOpenInterest", () => {
  it("uses oiCcy (base-currency units), not the raw contract-count oi", () => {
    // oi=4512370 contracts (0.01 BTC each) vs oiCcy=45123.7 BTC — using oi
    // directly would be off by ~100x for BTC-USDT-SWAP.
    expect(parseOpenInterest({ data: [{ instId: "BTC-USDT-SWAP", oi: "4512370", oiCcy: "45123.7", ts: "123" }] })).toEqual({
      oiBase: 45123.7,
      ts: 123
    });
  });

  it("returns null when there is no data", () => {
    expect(parseOpenInterest({ data: [] })).toBeNull();
  });
});

describe("parseLongShortRatio", () => {
  it("derives long%/short% fractions from OKX's single ratio value", () => {
    // ratio = 2.0 -> longAccount% = 2/3, shortAccount% = 1/3 (sums to 1).
    const resp: OkxLongShortRatioResponse = { data: [["1700000000000", "2.0"]] };
    const parsed = parseLongShortRatio(resp);
    expect(parsed?.lsRatio).toBe(2.0);
    expect(parsed?.longRatio).toBeCloseTo(2 / 3);
    expect(parsed?.shortRatio).toBeCloseTo(1 / 3);
    expect((parsed?.longRatio ?? 0) + (parsed?.shortRatio ?? 0)).toBeCloseTo(1);
  });

  it("returns null when there is no data", () => {
    expect(parseLongShortRatio({ data: [] })).toBeNull();
  });
});

describe("parseLiquidationOrders", () => {
  it("buckets fills into 5-minute windows and sums notional by posSide", () => {
    const resp: OkxLiquidationOrdersResponse = {
      data: [
        {
          details: [
            { bkPx: "50000", sz: "100", posSide: "long", ts: "1000" }, // bucket 0
            { bkPx: "51000", sz: "50", posSide: "short", ts: "50000" }, // same bucket
            { bkPx: "49000", sz: "200", posSide: "long", ts: (5 * 60_000 + 1000).toString() } // next bucket
          ]
        }
      ]
    };
    const buckets = parseLiquidationOrders(resp, "BTC-USDT-SWAP");
    expect(buckets).toHaveLength(2);
    // BTC-USDT-SWAP face value = 0.01 BTC/contract.
    expect(buckets[0]?.ts).toBe(0);
    expect(buckets[0]?.longLiqUsd).toBeCloseTo(100 * 0.01 * 50000);
    expect(buckets[0]?.shortLiqUsd).toBeCloseTo(50 * 0.01 * 51000);
    expect(buckets[0]?.events).toBe(2);
    expect(buckets[1]?.ts).toBe(5 * 60_000);
    expect(buckets[1]?.longLiqUsd).toBeCloseTo(200 * 0.01 * 49000);
  });

  it("returns an empty array for an instrument with no known contract face value", () => {
    const resp: OkxLiquidationOrdersResponse = {
      data: [{ details: [{ bkPx: "1", sz: "1", posSide: "long", ts: "1000" }] }]
    };
    expect(parseLiquidationOrders(resp, "SOL-USDT-SWAP")).toEqual([]);
  });
});
