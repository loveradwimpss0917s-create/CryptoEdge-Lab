// Tick -> source slot assignment (docs/01 §3.1, §4.6). This table is the
// single place that decides which adapters run on which Cron Trigger. Keep
// each tier's total `requestBudget` well under the Workers Free subrequest
// cap (50/invocation, we budget to 40 — docs/13 §1).
//
// Extending: adding a data source is "write an Adapter, push it into the
// right tier array here" — no other file needs to change (docs/03 §7
// five-point checklist).

import {
  BINANCE_INSTRUMENTS,
  makeBinanceFundingSnapshotAdapter,
  makeBinanceKlines1mAdapter,
  makeBinanceOpenInterestAdapter
} from "./adapters/binance.js";
import { alternativeMeFearGreedAdapter } from "./adapters/alternative-me.js";
import { deribitDvolAdapter } from "./adapters/deribit.js";
import type { Adapter } from "./adapters/types.js";

const futuresInstruments = BINANCE_INSTRUMENTS.filter((i) => i.isFutures);

// ---- tick-5m: "*/5 * * * *" ------------------------------------------
// Budget: 3 (klines) + 2 (funding) + 2 (OI) = 7 requests, well under 40.
export const STREAMS_5M: Adapter[] = [
  ...BINANCE_INSTRUMENTS.map(makeBinanceKlines1mAdapter),
  ...futuresInstruments.map(makeBinanceFundingSnapshotAdapter),
  ...futuresInstruments.map(makeBinanceOpenInterestAdapter)
];

// ---- tick-1h: "17 * * * *" ---------------------------------------------
export const STREAMS_1H: Adapter[] = [
  deribitDvolAdapter
  // TODO (docs/03 §2.1, §2.2): 1h candle confirmation across venues,
  // funding-rate history sync (bybit_rest, okx_rest), liquidations_5m via
  // coinglass_v4 free tier, long_short_ratios (Binance topLongShortAccountRatio
  // etc). Each is a follow-up Adapter registered here — no scheduler changes
  // needed beyond this array (docs/03 §7).
];

// ---- tick-1d: "23 1 * * *" -----------------------------------------------
// Ordering matters here (docs/03 §4 G1 -> G2 -> G3); this Worker only owns
// G1 (independent fetches). G2 (derived: SSR, Puell, ETF cumulative) and G3
// (DQ digest + research dispatch) run in research-worker's daily-light job
// (docs/01 §3.2) once G1 has landed in D1/R2.
export const STREAMS_1D: Adapter[] = [
  alternativeMeFearGreedAdapter
  // TODO (docs/03 §2.3-2.5): coinmetrics_community (~40 series), defillama
  // (stablecoin mcap, DEX volumes), fred (DXY/M2/VIX/T10Y2Y — requires
  // FRED_API_KEY), farside_etf (HTML scrape), etherscan/tronscan (USDT
  // Treasury mint/burn -> events table), yahoo_finance (BTC=F for the
  // CME-gap seed edge), econ_calendar (FOMC/CPI/NFP -> events table).
];

// ---- tick-weekly: "0 3 * * sun" ---------------------------------------------
export const STREAMS_WEEKLY: Adapter[] = [
  // TODO (docs/03 §2.5): cftc_cot (COT report), google_trends. This tick is
  // also where the ingest Worker triggers the `research-weekly`
  // repository_dispatch (docs/01 §3.2) once weekly streams have landed —
  // implemented in index.ts, not here, since dispatch isn't an Adapter.
];

export type Tier = "5m" | "1h" | "1d" | "weekly";

const CRON_TO_TIER: Record<string, Tier> = {
  "*/5 * * * *": "5m",
  "17 * * * *": "1h",
  "23 1 * * *": "1d",
  "0 3 * * sun": "weekly"
};

export function tierForCron(cron: string): Tier {
  const tier = CRON_TO_TIER[cron];
  if (!tier) throw new Error(`unrecognized cron expression: ${cron}`);
  return tier;
}

export function streamsForTier(tier: Tier): Adapter[] {
  switch (tier) {
    case "5m":
      return STREAMS_5M;
    case "1h":
      return STREAMS_1H;
    case "1d":
      return STREAMS_1D;
    case "weekly":
      return STREAMS_WEEKLY;
  }
}
