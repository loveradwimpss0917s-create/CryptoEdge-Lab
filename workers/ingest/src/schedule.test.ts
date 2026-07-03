import { describe, expect, it } from "vitest";
import { STREAMS_1D, STREAMS_1H, STREAMS_5M, streamsForTier, tierForCron } from "./schedule.js";

describe("tierForCron (docs/01 §4.6 cron -> tier map)", () => {
  it("maps each configured cron expression to its tier", () => {
    expect(tierForCron("*/5 * * * *")).toBe("5m");
    expect(tierForCron("17 * * * *")).toBe("1h");
    expect(tierForCron("23 1 * * *")).toBe("1d");
    expect(tierForCron("0 3 * * sun")).toBe("weekly");
  });

  it("throws on an unrecognized cron expression", () => {
    expect(() => tierForCron("* * * * *")).toThrow();
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
