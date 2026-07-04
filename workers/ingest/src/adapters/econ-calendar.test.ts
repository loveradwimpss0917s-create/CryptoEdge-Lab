import { describe, expect, it } from "vitest";
import { ECON_CALENDAR, entryDedupeKey } from "./econ-calendar.js";

describe("entryDedupeKey", () => {
  it("combines event type and date so re-seeding the same entry is idempotent", () => {
    expect(entryDedupeKey({ eventType: "fomc", date: "2026-01-28" })).toBe("fomc:2026-01-28");
  });
});

describe("ECON_CALENDAR (docs/15 SONNET-6)", () => {
  it("contains exactly the 8 cross-verified 2026 FOMC dates", () => {
    const fomc = ECON_CALENDAR.filter((e) => e.eventType === "fomc").map((e) => e.date);
    expect(fomc).toEqual([
      "2026-01-28",
      "2026-03-18",
      "2026-04-29",
      "2026-06-17",
      "2026-07-29",
      "2026-09-16",
      "2026-10-28",
      "2026-12-09"
    ]);
  });

  it("does not fabricate cpi_release/nfp_release/ppi_release dates (module docstring)", () => {
    // Only 2 of 12 2026 CPI dates could be cross-verified from this
    // environment (no direct fetch access to bls.gov's full published
    // schedule) -- left empty rather than guessing the rest. This test
    // exists so an accidental placeholder/guessed entry sneaking in later
    // gets caught rather than silently shipped.
    const other = ECON_CALENDAR.filter((e) => e.eventType !== "fomc");
    expect(other).toEqual([]);
  });
});
