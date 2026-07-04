// Manual macro event calendar (docs/03 §2.5 `econ_calendar`). FOMC
// meeting dates are set and published by the Fed roughly a year ahead;
// CPI/NFP/PPI release dates follow the BLS's published schedule. Neither
// has a stable free API, so docs/03 §2.5 calls for a manual seed ("手動
// シード + 公式ソース ... 年1回手動更新 + ingest自動補完") -- this module
// is that seed list plus the ingest step that upserts it into `events`.
//
// IMPORTANT: ECON_CALENDAR below ships EMPTY. Populate it from the Fed's
// official FOMC calendar (federalreserve.gov/monetarypolicy/
// fomccalendars.htm) and the BLS's release schedule (bls.gov/schedule/)
// -- this deliberately does not fabricate dates from training knowledge,
// since a wrong date silently corrupts every event-referencing
// signal_spec's evaluation rather than failing loudly. Re-verify and
// extend once a year (docs/03 §2.5), or whenever an edge_version starts
// referencing a new event_type from this list.

import { upsertEvent } from "../db.js";
import type { Adapter, AdapterRunResult } from "./types.js";

export interface EconCalendarEntry {
  eventType: "fomc" | "cpi_release" | "nfp_release" | "ppi_release";
  /** UTC date the event is scheduled/released, "YYYY-MM-DD". */
  date: string;
}

export const ECON_CALENDAR: EconCalendarEntry[] = [
  // FOMC 2026 (docs/15 SONNET-6, 2026-07): the decision/announcement day
  // (day 2 of each 2-day meeting) -- cross-verified against the Fed's own
  // per-meeting press-conference pages and multiple independent secondary
  // calendars (fedratecalc.com, MEXC, financecalendar.com, Yahoo Finance),
  // all agreeing on the same 8 dates.
  { eventType: "fomc", date: "2026-01-28" },
  { eventType: "fomc", date: "2026-03-18" },
  { eventType: "fomc", date: "2026-04-29" },
  { eventType: "fomc", date: "2026-06-17" },
  { eventType: "fomc", date: "2026-07-29" },
  { eventType: "fomc", date: "2026-09-16" },
  { eventType: "fomc", date: "2026-10-28" },
  { eventType: "fomc", date: "2026-12-09" }
  // cpi_release/nfp_release/ppi_release: NOT populated yet -- only 2 of 12
  // 2026 CPI release dates could be cross-verified from this environment
  // (no direct fetch access to bls.gov's full published schedule), and
  // this list deliberately does not fabricate the rest (see module
  // docstring). Populate once the complete bls.gov/schedule/2026 calendar
  // can be confirmed.
];

const STREAM_ID = "econ_calendar:macro_events";

export function entryDedupeKey(entry: EconCalendarEntry): string {
  return `${entry.eventType}:${entry.date}`;
}

export const econCalendarAdapter: Adapter = {
  sourceId: "econ_calendar",
  streamId: STREAM_ID,
  requestBudget: 0, // no fetch -- upserts the static ECON_CALENDAR list above
  async run(env): Promise<AdapterRunResult> {
    const results = await Promise.all(
      ECON_CALENDAR.map((entry) =>
        upsertEvent(env, {
          eventType: entry.eventType,
          ts: Date.parse(`${entry.date}T00:00:00Z`),
          sourceId: "econ_calendar",
          dedupeKey: entryDedupeKey(entry)
        })
      )
    );
    const written = results.filter(Boolean).length;
    return { streamId: STREAM_ID, rowsWritten: written, watermarkTs: Date.now() };
  }
};
