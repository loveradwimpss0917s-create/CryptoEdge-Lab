import { describe, expect, it } from "vitest";
import { ECON_CALENDAR, entryDedupeKey } from "./econ-calendar.js";

describe("entryDedupeKey", () => {
  it("combines event type and date so re-seeding the same entry is idempotent", () => {
    expect(entryDedupeKey({ eventType: "fomc", date: "2026-01-28" })).toBe("fomc:2026-01-28");
  });
});

describe("ECON_CALENDAR", () => {
  it("ships empty until populated with verified dates from an official source (module docstring)", () => {
    // Deliberately not fabricating FOMC/CPI/NFP/PPI dates here -- see
    // econ-calendar.ts's module docstring for why and what to fill this
    // with. This test exists so an accidental placeholder entry sneaking
    // in later gets caught rather than silently shipped.
    expect(ECON_CALENDAR).toEqual([]);
  });
});
