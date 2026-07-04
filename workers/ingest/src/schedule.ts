// Tick -> source slot assignment (docs/01 §3.1, §4.6). This table is the
// single place that decides which adapters run on which Cron Trigger. Keep
// each tier's total `requestBudget` well under the Workers Free subrequest
// cap (50/invocation, we budget to 40 — docs/13 §1).
//
// Extending: adding a data source is "write an Adapter, push it into the
// right tier array here" — no other file needs to change (docs/03 §7
// five-point checklist).

import {
  TRACKED_INSTRUMENTS,
  makeOkxCandlesAdapter,
  makeOkxFundingRateAdapter,
  makeOkxLiquidationsAdapter,
  makeOkxLongShortRatioAdapter,
  makeOkxOpenInterestAdapter
} from "./adapters/okx.js";
import { alternativeMeFearGreedAdapter } from "./adapters/alternative-me.js";
import { deribitDvolAdapter } from "./adapters/deribit.js";
import { econCalendarAdapter } from "./adapters/econ-calendar.js";
import { etherscanUsdtMintAdapter } from "./adapters/etherscan.js";
import type { Adapter } from "./adapters/types.js";
import { yahooCmeGapAdapter } from "./adapters/yahoo-finance.js";

const futuresInstruments = TRACKED_INSTRUMENTS.filter((i) => i.isFutures);

// ---- tick-5m: "*/5 * * * *" ------------------------------------------
// Budget: 3 (candles) + 2 (funding) + 2 (OI) = 7 requests, well under 40.
// Sourced via OKX, not Binance/CoinGecko (docs/03 §2.1 — Binance and Bybit
// block Cloudflare Workers' egress IPs outright; CoinGecko's free-tier
// rate limit gets exhausted by the whole platform's shared IP pool).
export const STREAMS_5M: Adapter[] = [
  ...TRACKED_INSTRUMENTS.map(makeOkxCandlesAdapter),
  ...futuresInstruments.map(makeOkxFundingRateAdapter),
  ...futuresInstruments.map(makeOkxOpenInterestAdapter)
];

// ---- tick-1h: fires when the wall clock hits :15 each hour ---------------
// Budget: 1 (DVOL) + 2 (LS ratio) + 2 (liquidations) = 5, well under 40.
export const STREAMS_1H: Adapter[] = [
  deribitDvolAdapter,
  // SONNET-1 (docs/15 §4): long_short_ratios/liquidations_5m never had a
  // live writer (docs/14 §6). OKX rubik + public liquidation-orders are the
  // only key-free public sources (docs/03 §2.2) — CoinGlass v4 would need
  // an API key signup that isn't available in a non-interactive session.
  ...futuresInstruments.map(makeOkxLongShortRatioAdapter),
  ...futuresInstruments.map(makeOkxLiquidationsAdapter)
  // TODO (docs/03 §2.1): 1h candle confirmation across venues, funding-rate
  // history sync (bybit_rest, okx_rest) — each a follow-up Adapter
  // registered here, no scheduler changes needed beyond this array
  // (docs/03 §7).
];

// ---- tick-1d: fires at 01:20 UTC -----------------------------------------
// Ordering matters here (docs/03 §4 G1 -> G2 -> G3); this Worker only owns
// G1 (independent fetches). G2 (derived: SSR, Puell, ETF cumulative) and G3
// (DQ digest + research dispatch) run in research-worker's daily-light job
// (docs/01 §3.2) once G1 has landed in D1/R2.
export const STREAMS_1D: Adapter[] = [
  alternativeMeFearGreedAdapter,
  // Event Engine v1 (docs/04 §5, 2026-07 design audit TASK-4): the first
  // three `events` writers. econCalendarAdapter's ECON_CALENDAR ships
  // empty (see its module docstring) until populated with verified
  // FOMC/CPI/NFP/PPI dates from official sources, so it's a no-op write
  // until then, not a placeholder to remove.
  yahooCmeGapAdapter,
  etherscanUsdtMintAdapter,
  econCalendarAdapter
  // TODO (docs/03 §2.3-2.5): coinmetrics_community (~40 series), defillama
  // (stablecoin mcap, DEX volumes), fred (DXY/M2/VIX/T10Y2Y — requires
  // FRED_API_KEY), farside_etf (HTML scrape), tronscan (USDT Treasury
  // mint/burn on Tron, redundant with etherscanUsdtMintAdapter's Ethereum
  // coverage).
];

// ---- tick-weekly: fires Sunday 03:00 UTC ---------------------------------
export const STREAMS_WEEKLY: Adapter[] = [
  // TODO (docs/03 §2.5): cftc_cot (COT report), google_trends. This tick is
  // also where the ingest Worker triggers the `research-weekly`
  // repository_dispatch (docs/01 §3.2) once weekly streams have landed —
  // implemented in index.ts, not here, since dispatch isn't an Adapter.
];

export type Tier = "5m" | "1h" | "1d" | "weekly";

// The Cloudflare account this Worker shares with unrelated projects is
// pinned at the Workers Free plan's 5-cron-trigger-per-account cap, and
// those other projects already hold some of that budget. Rather than
// register 4 more Cron Triggers here (and fail account-wide), this Worker
// registers a single "*/5 * * * *" trigger and derives which tiers are due
// from the wall clock on every 5-minute tick — the 5m tier always runs, and
// the slower tiers piggyback on whichever 5-minute mark lands closest to
// their old standalone schedule (docs/01 §4.6).
export function tiersForTick(now: Date): Tier[] {
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const day = now.getUTCDay(); // 0 = Sunday

  const tiers: Tier[] = ["5m"];
  if (minute === 15) tiers.push("1h");
  if (hour === 1 && minute === 20) tiers.push("1d");
  if (day === 0 && hour === 3 && minute === 0) tiers.push("weekly");
  return tiers;
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
