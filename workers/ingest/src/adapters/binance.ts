// Binance REST adapters (docs/03 §2.1 `binance_rest`). No API key required.
// Covers the core market-data spine: 1m candles, predicted funding, and
// open interest for the two seed instruments (docs/09 §3).
//
// Each `parse*` function is a pure function taking a raw API response and
// returning normalized rows — no fetch, no D1 — so it can be unit-tested
// against a recorded fixture without a network or database (docs/11 §2).

import { upsertCandles, upsertLatestSnapshot, upsertMetric } from "../db.js";
import type { CandleRow } from "@cryptoedge/schema";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson } from "./types.js";

const SPOT_BASE = "https://api.binance.com";
const FUT_BASE = "https://fapi.binance.com";

export interface BinanceInstrument {
  instrumentId: string;
  symbol: string;
  base: string;
  isFutures: boolean;
}

export const BINANCE_INSTRUMENTS: BinanceInstrument[] = [
  { instrumentId: "BTCUSDT.BINANCE.PERP", symbol: "BTCUSDT", base: FUT_BASE, isFutures: true },
  { instrumentId: "BTCUSDT.BINANCE.SPOT", symbol: "BTCUSDT", base: SPOT_BASE, isFutures: false },
  { instrumentId: "ETHUSDT.BINANCE.PERP", symbol: "ETHUSDT", base: FUT_BASE, isFutures: true }
];

export type RawKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

export type CandleInsert = Omit<CandleRow, "ingested_at">;

/** Drops the last (possibly unclosed) candle — only confirmed bars are persisted (docs/02 candles). */
export function parseKlines1m(raw: RawKline[], instrumentId: string): CandleInsert[] {
  return raw.slice(0, -1).map((k) => ({
    instrument_id: instrumentId,
    tf: "1m" as const,
    ts: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    quote_volume: Number(k[7]),
    taker_buy_volume: Number(k[9]),
    trades: k[8]
  }));
}

/** Fetches the last few confirmed 1m candles — a 5-minute tick backfills any it missed since the previous run (docs/01 §3.1). */
export function makeBinanceKlines1mAdapter(instrument: BinanceInstrument): Adapter {
  const streamId = `binance_rest:klines_1m:${instrument.instrumentId}`;
  return {
    sourceId: "binance_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      const endpoint = instrument.isFutures ? "/fapi/v1/klines" : "/api/v3/klines";
      const url = `${instrument.base}${endpoint}?symbol=${instrument.symbol}&interval=1m&limit=6`;
      const raw = await fetchJson<RawKline[]>(url);
      const rows = parseKlines1m(raw, instrument.instrumentId);
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

export interface PremiumIndexResponse {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

export function parseFundingSnapshot(data: PremiumIndexResponse) {
  return {
    rate: Number(data.lastFundingRate),
    markPrice: Number(data.markPrice),
    nextFundingTime: data.nextFundingTime,
    ts: data.time
  };
}

/** Predicted/current funding snapshot (docs/03 §3 `deriv.predicted_funding.binance`). Futures only. */
export function makeBinanceFundingSnapshotAdapter(instrument: BinanceInstrument): Adapter {
  const streamId = `binance_rest:funding_snapshot:${instrument.instrumentId}`;
  return {
    sourceId: "binance_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      const url = `${FUT_BASE}/fapi/v1/premiumIndex?symbol=${instrument.symbol}`;
      const parsed = parseFundingSnapshot(await fetchJson<PremiumIndexResponse>(url));
      await upsertMetric(env, `deriv.predicted_funding.binance.${instrument.symbol}`, parsed.ts, parsed.rate, {
        markPrice: parsed.markPrice,
        nextFundingTime: parsed.nextFundingTime
      });
      await upsertLatestSnapshot(env, `funding:binance:${instrument.symbol}`, {
        v: parsed.rate,
        ts: parsed.ts,
        ingested_at: Date.now()
      });
      return { streamId, rowsWritten: 1, watermarkTs: parsed.ts };
    }
  };
}

export interface OpenInterestResponse {
  symbol: string;
  openInterest: string;
  time: number;
}

export function parseOpenInterest(data: OpenInterestResponse) {
  return { oiBase: Number(data.openInterest), ts: data.time };
}

export function makeBinanceOpenInterestAdapter(instrument: BinanceInstrument): Adapter {
  const streamId = `binance_rest:open_interest:${instrument.instrumentId}`;
  return {
    sourceId: "binance_rest",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      const url = `${FUT_BASE}/fapi/v1/openInterest?symbol=${instrument.symbol}`;
      const parsed = parseOpenInterest(await fetchJson<OpenInterestResponse>(url));
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
