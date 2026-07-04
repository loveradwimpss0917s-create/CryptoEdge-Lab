// OKX v5 public REST adapters (docs/03 §2.1 `okx_rest`). Replaces the
// CoinGecko adapters: CoinGecko's free tier shares Cloudflare Workers'
// egress IP pool with countless other Workers users, and its per-IP rate
// limit gets exhausted by that collective traffic (observed both 403 and
// 429 on first-ever requests from this Worker). A live reachability probe
// (diagnostics.ts, 2026-07) confirmed OKX, Coinbase, Kraken, and Deribit
// all respond cleanly; OKX was chosen because its v5 API covers price +
// funding rate + open interest in one coherent surface, like the original
// (blocked) Binance design.
//
// NOTE ON INSTRUMENT LABELING: the existing instrument_id/venue values
// (e.g. BTCUSDT.BINANCE.PERP) predate this switch and are referenced
// directly by several seeded edge_versions.signal_spec — renaming them
// would break those references. Price is a reasonable cross-venue proxy
// (tight arbitrage), but funding rate / open interest are venue-specific
// figures now sourced from OKX while stored under the legacy
// Binance-labeled instrument_id. Documented here and in docs/03 §2.1 so
// this isn't silently misread as literal Binance data later.
//
// Each `parse*` function is a pure function taking a raw API response and
// returning normalized rows — no fetch, no D1 — so it can be unit-tested
// against a recorded fixture without a network or database (docs/11 §2).

import { recordWrites, upsertCandles, upsertLatestSnapshot, upsertMetric } from "../db.js";
import type { CandleRow } from "@cryptoedge/schema";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson, jitterDelay } from "./types.js";

const OKX_BASE = "https://www.okx.com";

export interface TrackedInstrument {
  instrumentId: string;
  symbol: string;
  okxInstId: string;
  isFutures: boolean;
}

export const TRACKED_INSTRUMENTS: TrackedInstrument[] = [
  { instrumentId: "BTCUSDT.BINANCE.PERP", symbol: "BTCUSDT", okxInstId: "BTC-USDT-SWAP", isFutures: true },
  { instrumentId: "BTCUSDT.BINANCE.SPOT", symbol: "BTCUSDT", okxInstId: "BTC-USDT", isFutures: false },
  { instrumentId: "ETHUSDT.BINANCE.PERP", symbol: "ETHUSDT", okxInstId: "ETH-USDT-SWAP", isFutures: true }
];

/** [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm] — OKX returns newest-first. */
export type OkxCandleRaw = string[];

export type CandleInsert = Omit<CandleRow, "ingested_at">;

/**
 * Reverses OKX's newest-first order and keeps only closed (confirm === "1")
 * bars. Volume unit differs by instrument type (2026-07 review finding): for
 * SPOT, `vol` (k[5]) is already base-currency volume; for SWAP, `vol` is a
 * contract count, so `volCcy` (k[6], base-currency) is used instead —
 * otherwise volume wouldn't be comparable across instruments for CVD/volume
 * features.
 */
export function parseOkxCandles(raw: OkxCandleRaw[], instrumentId: string, isFutures: boolean): CandleInsert[] {
  return [...raw]
    .reverse()
    .filter((k) => k[8] === "1")
    .map((k) => ({
      instrument_id: instrumentId,
      tf: "1m" as const,
      ts: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: isFutures ? Number(k[6]) : Number(k[5]),
      quote_volume: isFutures ? Number(k[7]) : Number(k[6]),
      taker_buy_volume: null,
      trades: null
    }));
}

export function makeOkxCandlesAdapter(instrument: TrackedInstrument): Adapter {
  const streamId = `okx_rest:candles_1m:${instrument.instrumentId}`;
  return {
    sourceId: "okx_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      await jitterDelay();
      const url = `${OKX_BASE}/api/v5/market/candles?instId=${instrument.okxInstId}&bar=1m&limit=6`;
      const raw = await fetchJson<{ data: OkxCandleRaw[] }>(url);
      const rows = parseOkxCandles(raw.data, instrument.instrumentId, instrument.isFutures);
      await upsertCandles(env, rows);
      const last = rows.at(-1);
      if (last) {
        await upsertLatestSnapshot(env, `candle:1m:${instrument.instrumentId}`, {
          v: last.close,
          ts: last.ts,
          ingested_at: Date.now()
        });
      }
      return { streamId, rowsWritten: rows.length, watermarkTs: last?.ts ?? Date.now() };
    }
  };
}

export interface OkxFundingRateResponse {
  data: { instId: string; fundingRate: string; fundingTime: string }[];
}

/**
 * `fundingTime` is OKX's *next* settlement time (a future timestamp), not
 * when this rate was observed — storing it as the metric's `ts` was a PIT
 * violation (2026-07 review finding: as-of joins would see a future value
 * as if it were already known). The caller uses `Date.now()` as `ts` and
 * keeps `fundingTime` only as `meta.next_funding_time` context.
 */
export function parseFundingRate(resp: OkxFundingRateResponse): { rate: number; nextFundingTime: number } | null {
  const entry = resp.data[0];
  return entry ? { rate: Number(entry.fundingRate), nextFundingTime: Number(entry.fundingTime) } : null;
}

export function makeOkxFundingRateAdapter(instrument: TrackedInstrument): Adapter {
  const streamId = `okx_rest:funding_rate:${instrument.instrumentId}`;
  return {
    sourceId: "okx_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      await jitterDelay();
      const url = `${OKX_BASE}/api/v5/public/funding-rate?instId=${instrument.okxInstId}`;
      const parsed = parseFundingRate(await fetchJson<OkxFundingRateResponse>(url));
      if (!parsed) return { streamId, rowsWritten: 0, watermarkTs: Date.now() };
      const ts = Date.now();
      await upsertMetric(
        env,
        `deriv.predicted_funding.binance.${instrument.symbol}`,
        ts,
        parsed.rate,
        { next_funding_time: parsed.nextFundingTime },
        { skipIfUnchanged: true }
      );
      await upsertLatestSnapshot(env, `funding:binance:${instrument.symbol}`, {
        v: parsed.rate,
        ts,
        ingested_at: ts
      });
      return { streamId, rowsWritten: 1, watermarkTs: ts };
    }
  };
}

export interface OkxOpenInterestResponse {
  data: { instId: string; oi: string; oiCcy: string; ts: string }[];
}

/**
 * `oi` is a contract count (for BTC-USDT-SWAP, 1 contract = 0.01 BTC, so
 * using it directly as a base-currency quantity was off by ~100x — 2026-07
 * review finding). `oiCcy` is already denominated in the underlying asset,
 * which is what `open_interest.oi_base` is documented to hold (docs/02).
 */
export function parseOpenInterest(resp: OkxOpenInterestResponse): { oiBase: number; ts: number } | null {
  const entry = resp.data[0];
  return entry ? { oiBase: Number(entry.oiCcy), ts: Number(entry.ts) } : null;
}

export function makeOkxOpenInterestAdapter(instrument: TrackedInstrument): Adapter {
  const streamId = `okx_rest:open_interest:${instrument.instrumentId}`;
  return {
    sourceId: "okx_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      await jitterDelay();
      const url = `${OKX_BASE}/api/v5/public/open-interest?instId=${instrument.okxInstId}`;
      const parsed = parseOpenInterest(await fetchJson<OkxOpenInterestResponse>(url));
      if (!parsed) return { streamId, rowsWritten: 0, watermarkTs: Date.now() };
      await env.DB.prepare(
        `INSERT INTO open_interest (instrument_id, ts, oi_base, oi_usd, ingested_at)
         VALUES (?1, ?2, ?3, NULL, ?4)
         ON CONFLICT (instrument_id, ts) DO UPDATE SET oi_base = excluded.oi_base, ingested_at = excluded.ingested_at`
      )
        .bind(instrument.instrumentId, parsed.ts, parsed.oiBase, Date.now())
        .run();
      await upsertLatestSnapshot(env, `oi:binance:${instrument.symbol}`, {
        v: parsed.oiBase,
        ts: parsed.ts,
        ingested_at: Date.now()
      });
      return { streamId, rowsWritten: 1, watermarkTs: parsed.ts };
    }
  };
}

export interface OkxLongShortRatioResponse {
  /** [ts, ratio], newest-first (same convention as candles) — no auth required. */
  data: [string, string][];
}

/**
 * SONNET-1 (docs/15 §4): long_short_ratios has never had a live writer
 * (docs/14 §6 finding — `ls_top_trader_z_30d`/`ls_all_account_z_30d`
 * features exist but their base table is empty). OKX's rubik "trading
 * data" long/short account ratio is the only key-free public source
 * (docs/03 §2.2 already names "OKX rubik" as the V1 plan; CoinGlass v4
 * would need an API key signup, which isn't available in a non-interactive
 * session). It reports a single ratio (long-position-count /
 * short-position-count), not the long%/short% breakdown this project's
 * schema stores — but since long% + short% = 1 and ratio = long%/short%,
 * both fractions are recoverable: long% = ratio/(1+ratio), short% =
 * 1/(1+ratio). Written as ratio_type='all_account'; OKX has no public
 * "top trader" breakdown, so `ls_top_trader_z_30d` stays DATA_PENDING
 * until a keyed source is added.
 */
export function parseLongShortRatio(
  resp: OkxLongShortRatioResponse
): { ts: number; longRatio: number; shortRatio: number; lsRatio: number } | null {
  const entry = resp.data[0];
  if (!entry) return null;
  const ts = Number(entry[0]);
  const ratio = Number(entry[1]);
  return { ts, longRatio: ratio / (1 + ratio), shortRatio: 1 / (1 + ratio), lsRatio: ratio };
}

export function makeOkxLongShortRatioAdapter(instrument: TrackedInstrument): Adapter {
  const streamId = `okx_rest:long_short_ratio:${instrument.instrumentId}`;
  return {
    sourceId: "okx_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      await jitterDelay();
      const url = `${OKX_BASE}/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?instId=${instrument.okxInstId}&period=5m`;
      const parsed = parseLongShortRatio(await fetchJson<OkxLongShortRatioResponse>(url));
      if (!parsed) return { streamId, rowsWritten: 0, watermarkTs: Date.now() };
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO long_short_ratios (instrument_id, ratio_type, ts, long_ratio, short_ratio, ls_ratio, ingested_at)
         VALUES (?1, 'all_account', ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (instrument_id, ratio_type, ts) DO UPDATE SET
           long_ratio = excluded.long_ratio, short_ratio = excluded.short_ratio,
           ls_ratio = excluded.ls_ratio, ingested_at = excluded.ingested_at`
      )
        .bind(instrument.instrumentId, parsed.ts, parsed.longRatio, parsed.shortRatio, parsed.lsRatio, now)
        .run();
      await recordWrites(env, "d1_writes", 1);
      await upsertLatestSnapshot(env, `ls_ratio:okx:${instrument.symbol}`, { v: parsed.lsRatio, ts: parsed.ts, ingested_at: now });
      return { streamId, rowsWritten: 1, watermarkTs: parsed.ts };
    }
  };
}

export interface OkxLiquidationOrderDetail {
  bkPx: string;
  sz: string;
  posSide: string;
  ts: string;
}

export interface OkxLiquidationGroup {
  details: OkxLiquidationOrderDetail[];
}

export interface OkxLiquidationOrdersResponse {
  data: OkxLiquidationGroup[];
}

const FIVE_MIN_MS = 5 * 60_000;

/**
 * OKX contract face values (published instrument specs, docs/03 §2.2):
 * BTC-USDT-SWAP = 0.01 BTC/contract, ETH-USDT-SWAP = 0.1 ETH/contract.
 * `liquidation-orders` reports fill size in contracts with no
 * currency-denominated alternative field (unlike open interest's `oiCcy`),
 * so the multiplier has to be applied by hand here — same unit gotcha as
 * `parseOpenInterest` above.
 */
const CONTRACT_FACE_VALUE: Record<string, number> = {
  "BTC-USDT-SWAP": 0.01,
  "ETH-USDT-SWAP": 0.1
};

export interface ParsedLiquidationBucket {
  ts: number;
  longLiqUsd: number;
  shortLiqUsd: number;
  events: number;
  maxSingleUsd: number;
}

/**
 * Buckets raw liquidation fills into 5-minute windows and sums notional
 * (contracts * face value * bankruptcy price) per side. `posSide` is the
 * liquidated position's side, not the closing order's own `side`. The
 * public endpoint only returns a recent rolling window of fills (no deep
 * pagination), so a burst exceeding that window between two hourly polls
 * is permanently undercounted — the same incompleteness docs/09 §3
 * already flags for liq-cascade-rebound ("清算系列の不完全性を
 * counter_evidence に明記"), not a new caveat introduced here.
 */
export function parseLiquidationOrders(resp: OkxLiquidationOrdersResponse, okxInstId: string): ParsedLiquidationBucket[] {
  const faceValue = CONTRACT_FACE_VALUE[okxInstId];
  if (!faceValue) return [];
  const buckets = new Map<number, ParsedLiquidationBucket>();
  for (const group of resp.data) {
    for (const detail of group.details) {
      const ts = Number(detail.ts);
      const bucketTs = Math.floor(ts / FIVE_MIN_MS) * FIVE_MIN_MS;
      const notionalUsd = Number(detail.sz) * faceValue * Number(detail.bkPx);
      const bucket = buckets.get(bucketTs) ?? { ts: bucketTs, longLiqUsd: 0, shortLiqUsd: 0, events: 0, maxSingleUsd: 0 };
      if (detail.posSide === "long") bucket.longLiqUsd += notionalUsd;
      else if (detail.posSide === "short") bucket.shortLiqUsd += notionalUsd;
      bucket.events += 1;
      bucket.maxSingleUsd = Math.max(bucket.maxSingleUsd, notionalUsd);
      buckets.set(bucketTs, bucket);
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

export function makeOkxLiquidationsAdapter(instrument: TrackedInstrument): Adapter {
  const streamId = `okx_rest:liquidations:${instrument.instrumentId}`;
  return {
    sourceId: "okx_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      await jitterDelay();
      const url = `${OKX_BASE}/api/v5/public/liquidation-orders?instType=SWAP&instId=${instrument.okxInstId}&state=filled`;
      const buckets = parseLiquidationOrders(await fetchJson<OkxLiquidationOrdersResponse>(url), instrument.okxInstId);
      if (buckets.length === 0) return { streamId, rowsWritten: 0, watermarkTs: Date.now() };
      const now = Date.now();
      const stmt = env.DB.prepare(
        `INSERT INTO liquidations_5m (instrument_id, ts, long_liq_usd, short_liq_usd, events, max_single_usd, source_id, ingested_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'okx_rest', ?7)
         ON CONFLICT (instrument_id, ts, source_id) DO UPDATE SET
           long_liq_usd = excluded.long_liq_usd, short_liq_usd = excluded.short_liq_usd,
           events = excluded.events, max_single_usd = excluded.max_single_usd, ingested_at = excluded.ingested_at`
      );
      await env.DB.batch(
        buckets.map((b) =>
          stmt.bind(instrument.instrumentId, b.ts, b.longLiqUsd, b.shortLiqUsd, b.events, b.maxSingleUsd, now)
        )
      );
      await recordWrites(env, "d1_writes", buckets.length);
      const last = buckets.at(-1)!;
      return { streamId, rowsWritten: buckets.length, watermarkTs: last.ts };
    }
  };
}
