import { describe, expect, it } from "vitest";
import { computeCmeGap, parseYahooDailyBars, type YahooChartResponse } from "./yahoo-finance.js";

function chart(timestamp: number[], open: (number | null)[], close: (number | null)[]): YahooChartResponse {
  return { chart: { result: [{ timestamp, indicators: { quote: [{ open, close }] } }], error: null } };
}

describe("parseYahooDailyBars", () => {
  it("drops bars with a null open/close (still-forming current-day bar)", () => {
    const bars = parseYahooDailyBars(chart([100, 200, 300], [10, 20, null], [11, 21, null]));
    expect(bars).toEqual([
      { ts: 100_000, open: 10, close: 11 },
      { ts: 200_000, open: 20, close: 21 }
    ]);
  });

  it("returns an empty array when there's no result (e.g. an error response)", () => {
    expect(parseYahooDailyBars({ chart: { result: null, error: "no data" } })).toEqual([]);
  });
});

const DAY = 86_400_000;

describe("computeCmeGap", () => {
  it("returns null for consecutive trading days (no weekend/holiday between them)", () => {
    const bars = [
      { ts: 0, open: 100, close: 101 },
      { ts: DAY, open: 101, close: 102 }
    ];
    expect(computeCmeGap(bars)).toBeNull();
  });

  it("detects a weekend gap (Friday close -> Monday open, 3 calendar days apart)", () => {
    const friday = 0;
    const monday = 3 * DAY;
    const bars = [
      { ts: friday, open: 100, close: 100 },
      { ts: monday, open: 105, close: 106 }
    ];
    const gap = computeCmeGap(bars);
    expect(gap).not.toBeNull();
    expect(gap!.gapDays).toBe(3);
    expect(gap!.magnitudePct).toBeCloseTo(5.0, 5); // (105-100)/100 * 100
  });

  it("returns null with fewer than 2 bars", () => {
    expect(computeCmeGap([{ ts: 0, open: 100, close: 100 }])).toBeNull();
    expect(computeCmeGap([])).toBeNull();
  });
});
