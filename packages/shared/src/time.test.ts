import { describe, expect, it } from "vitest";
import { dateKeyToMs, floorToInterval, toDateKey, utcDayOfWeek, utcHour } from "./time.js";

describe("time utilities (UTC-only, docs/02 conventions)", () => {
  it("round-trips date keys", () => {
    const ms = Date.parse("2026-07-02T00:00:00.000Z");
    expect(toDateKey(ms)).toBe("2026-07-02");
    expect(dateKeyToMs("2026-07-02")).toBe(ms);
  });

  it("reads UTC hour/day regardless of host timezone", () => {
    const ms = Date.parse("2026-07-02T21:30:00.000Z"); // Thursday
    expect(utcHour(ms)).toBe(21);
    expect(utcDayOfWeek(ms)).toBe(4);
  });

  it("floors to the enclosing interval", () => {
    const ms = Date.parse("2026-07-02T21:37:42.000Z");
    const floored = floorToInterval(ms, 5 * 60_000);
    expect(new Date(floored).toISOString()).toBe("2026-07-02T21:35:00.000Z");
  });
});
