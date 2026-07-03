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

import { upsertCandles, upsertLatestSnapshot, upsertMetric } from "../db.js";
import type { CandleRow } from "@cryptoedge/schema";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson } from "./types.js";

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

/** Reverses OKX's newest-first order and keeps only closed (confirm === "1") bars. */
export function parseOkxCandles(raw: OkxCandleRaw[], instrumentId: string): CandleInsert[] {
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
      volume: Number(k[5]),
      quote_volume: Number(k[7]),
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
      const url = `${OKX_BASE}/api/v5/market/candles?instId=${instrument.okxInstId}&bar=1m&limit=6`;
      const raw = await fetchJson<{ data: OkxCandleRaw[] }>(url);
      const rows = parseOkxCandles(raw.data, instrument.instrumentId);
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

export function parseFundingRate(resp: OkxFundingRateResponse): { rate: number; ts: number } | null {
  const entry = resp.data[0];
  return entry ? { rate: Number(entry.fundingRate), ts: Number(entry.fundingTime) } : null;
}

export function makeOkxFundingRateAdapter(instrument: TrackedInstrument): Adapter {
  const streamId = `okx_rest:funding_rate:${instrument.instrumentId}`;
  return {
    sourceId: "okx_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      const url = `${OKX_BASE}/api/v5/public/funding-rate?instId=${instrument.okxInstId}`;
      const parsed = parseFundingRate(await fetchJson<OkxFundingRateResponse>(url));
      if (!parsed) return { streamId, rowsWritten: 0, watermarkTs: Date.now() };
      await upsertMetric(env, `deriv.predicted_funding.binance.${instrument.symbol}`, parsed.ts, parsed.rate, {});
      await upsertLatestSnapshot(env, `funding:binance:${instrument.symbol}`, {
        v: parsed.rate,
        ts: parsed.ts,
        ingested_at: Date.now()
      });
      return { streamId, rowsWritten: 1, watermarkTs: parsed.ts };
    }
  };
}

export interface OkxOpenInterestResponse {
  data: { instId: string; oi: string; ts: string }[];
}

export function parseOpenInterest(resp: OkxOpenInterestResponse): { oiBase: number; ts: number } | null {
  const entry = resp.data[0];
  return entry ? { oiBase: Number(entry.oi), ts: Number(entry.ts) } : null;
}

export function makeOkxOpenInterestAdapter(instrument: TrackedInstrument): Adapter {
  const streamId = `okx_rest:open_interest:${instrument.instrumentId}`;
  return {
    sourceId: "okx_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
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
