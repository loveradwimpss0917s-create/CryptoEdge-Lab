import { describe, expect, it } from "vitest";
import { STREAMS_1D, STREAMS_1H, STREAMS_5M, streamsForTier, tiersForTick } from "./schedule.js";

describe("tiersForTick (docs/01 §4.6 wall-clock -> tier derivation)", () => {
  it("always includes the 5m tier", () => {
    expect(tiersForTick(new Date("2026-07-06T12:35:00Z"))).toEqual(["5m"]);
  });

  it("adds the 1h tier at :15 each hour", () => {
    expect(tiersForTick(new Date("2026-07-06T12:15:00Z"))).toEqual(["5m", "1h"]);
  });

  it("adds the 1d tier at 01:20 UTC", () => {
    expect(tiersForTick(new Date("2026-07-06T01:20:00Z"))).toEqual(["5m", "1d"]);
  });

  it("adds the weekly tier at Sunday 03:00 UTC", () => {
    // 2026-07-05 is a Sunday
    expect(tiersForTick(new Date("2026-07-05T03:00:00Z"))).toEqual(["5m", "weekly"]);
  });
});

describe("tick-5m subrequest budget (docs/13 §1: stay under 40/tick)", () => {
  it("stays well under the 40-subrequest budget", () => {
    const total = STREAMS_5M.reduce((sum, a) => sum + a.requestBudget, 0);
    expect(total).toBeLessThan(40);
  });

  it("every stream has a unique streamId across all tiers", () => {
    const all = [...STREAMS_5M, ...STREAMS_1H, ...STREAMS_1D, ...streamsForTier("weekly")];
    const ids = all.map((a) => a.streamId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
