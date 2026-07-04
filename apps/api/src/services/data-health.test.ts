import { describe, expect, it } from "vitest";
import { computeStreamQualityScore } from "./data-health.js";

describe("computeStreamQualityScore (docs/15 SONNET-4)", () => {
  it("scores 1.0 for a fresh stream with no errors", () => {
    const now = 1_000_000;
    const score = computeStreamQualityScore({
      streamId: "okx_rest:candles_1m:BTCUSDT.BINANCE.PERP", // 5m cadence
      lastRunAt: now - 60_000,
      lastStatus: "ok",
      consecutiveErrors: 0,
      now
    });
    expect(score).toBeCloseTo(1);
  });

  it("degrades freshness once a stream is past its cadence window", () => {
    const cadence = 5 * 60_000;
    const now = 1_000_000_000;
    const fresh = computeStreamQualityScore({
      streamId: "okx_rest:candles_1m:BTCUSDT.BINANCE.PERP",
      lastRunAt: now - cadence,
      lastStatus: "ok",
      consecutiveErrors: 0,
      now
    });
    const stale = computeStreamQualityScore({
      streamId: "okx_rest:candles_1m:BTCUSDT.BINANCE.PERP",
      lastRunAt: now - 3 * cadence,
      lastStatus: "ok",
      consecutiveErrors: 0,
      now
    });
    expect(stale).toBeLessThan(fresh);
    expect(stale).toBeCloseTo(0);
  });

  it("degrades with consecutive_errors even when fresh", () => {
    const now = 1_000_000;
    const score = computeStreamQualityScore({
      streamId: "okx_rest:liquidations:BTCUSDT.BINANCE.PERP",
      lastRunAt: now,
      lastStatus: "error:HTTP 400",
      consecutiveErrors: 5,
      now
    });
    expect(score).toBeCloseTo(0.5);
  });

  it("uses a longer cadence for daily (tick-1d) streams than 5m streams", () => {
    const now = 1_000_000_000;
    const twoHoursAgo = now - 2 * 60 * 60_000;
    const dailyScore = computeStreamQualityScore({
      streamId: "yahoo_finance:cme_gap:BTC1!.CME.FUT",
      lastRunAt: twoHoursAgo,
      lastStatus: "ok",
      consecutiveErrors: 0,
      now
    });
    const fiveMinScore = computeStreamQualityScore({
      streamId: "okx_rest:candles_1m:BTCUSDT.BINANCE.PERP",
      lastRunAt: twoHoursAgo,
      lastStatus: "ok",
      consecutiveErrors: 0,
      now
    });
    expect(dailyScore).toBeGreaterThan(fiveMinScore);
    expect(dailyScore).toBeCloseTo(1);
  });

  it("treats a stream with no run history as maximally stale", () => {
    const score = computeStreamQualityScore({
      streamId: "okx_rest:candles_1m:BTCUSDT.BINANCE.PERP",
      lastRunAt: null,
      lastStatus: null,
      consecutiveErrors: 0,
      now: 1_000_000
    });
    expect(score).toBe(0);
  });
});
