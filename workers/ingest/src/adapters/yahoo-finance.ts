// Yahoo Finance unofficial chart API (docs/03 §2.1 `yahoo_finance`): the
// only free source for CME BTC futures daily bars (docs/03 §2.1 "CME 先物
// ... 直接API なし ... Yahoo Finance BTC=F 日足で足りる"). Feeds the
// `cme_gap` event (docs/02, seed edge 021, 2026-07 design audit TASK-4):
// CME's BTC futures close over weekends/holidays while spot trades 24/7,
// so a jump between the last available daily bar's close and the next
// bar's open is a real information gap, not routine daily noise.
//
// Unofficial API, no auth, but no documented SLA either -- docs/03 §2.1
// flags this and specifies a Stooq CSV fallback for V2; not implemented
// yet since this is the only consumer so far.

import { upsertEvent } from "../db.js";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson } from "./types.js";

const STREAM_ID = "yahoo_finance:cme_gap:BTC1!.CME.FUT";
const MS_PER_DAY = 86_400_000;

export interface YahooChartResponse {
  chart: {
    result:
      | {
          timestamp: number[];
          indicators: { quote: { open: (number | null)[]; close: (number | null)[] }[] };
        }[]
      | null;
    error: unknown;
  };
}

export interface DailyBar {
  ts: number;
  open: number;
  close: number;
}

/** Drops any bar with a null open/close -- Yahoo pads the arrays with
 * nulls for the still-forming current-day bar and any data gaps. */
export function parseYahooDailyBars(resp: YahooChartResponse): DailyBar[] {
  const result = resp.chart.result?.[0];
  const quote = result?.indicators.quote[0];
  if (!result || !quote) return [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const open = quote.open[i];
    const close = quote.close[i];
    if (open == null || close == null) continue;
    bars.push({ ts: result.timestamp[i]! * 1000, open, close });
  }
  return bars;
}

export interface CmeGapEvent {
  ts: number;
  magnitudePct: number;
  gapDays: number;
}

/** Only the most recent transition matters -- a gap further back was
 * already reported (and deduped) by an earlier run. `null` when the last
 * two available bars are on consecutive trading days (ordinary case on
 * every non-Monday/non-post-holiday run). */
export function computeCmeGap(bars: DailyBar[]): CmeGapEvent | null {
  if (bars.length < 2) return null;
  const prev = bars[bars.length - 2]!;
  const curr = bars[bars.length - 1]!;
  const gapDays = Math.round((curr.ts - prev.ts) / MS_PER_DAY);
  if (gapDays < 2) return null;
  return { ts: curr.ts, magnitudePct: ((curr.open - prev.close) / prev.close) * 100, gapDays };
}

// 2026-07-11 (docs/17/19 follow-up): this stream had failed 6 consecutive
// daily ticks with HTTP 429 (live production ingest_state check) -- Yahoo's
// unofficial chart API is widely known to reject requests that don't look
// like they come from a browser (no realistic User-Agent/Accept), which
// Cloudflare Workers' default `fetch` doesn't send. Added the headers a
// browser would send; this is the best available fix without live traffic
// to confirm against (can't reach query1.finance.yahoo.com from this
// sandbox), so worth re-checking ingest_state.consecutive_errors for this
// stream after the next 1d tick.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json"
};

export const yahooCmeGapAdapter: Adapter = {
  sourceId: "yahoo_finance",
  streamId: STREAM_ID,
  requestBudget: 1,
  async run(env): Promise<AdapterRunResult> {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/BTC=F?range=10d&interval=1d";
    const bars = parseYahooDailyBars(await fetchJson<YahooChartResponse>(url, { headers: BROWSER_HEADERS }));
    const gap = computeCmeGap(bars);
    if (!gap) return { streamId: STREAM_ID, rowsWritten: 0, watermarkTs: Date.now() };

    const dateKey = new Date(gap.ts).toISOString().slice(0, 10);
    const written = await upsertEvent(env, {
      eventType: "cme_gap",
      ts: gap.ts,
      magnitude: Math.abs(gap.magnitudePct),
      payload: { magnitude_pct: gap.magnitudePct, gap_days: gap.gapDays },
      sourceId: "yahoo_finance",
      dedupeKey: `cme_gap:${dateKey}`
    });
    return { streamId: STREAM_ID, rowsWritten: written ? 1 : 0, watermarkTs: gap.ts };
  }
};
