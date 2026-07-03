// CoinGecko public API adapters (docs/03 §2.1 `coingecko`). Replaces the
// prior direct-to-Binance adapters: Binance's WAF blocks Cloudflare
// Workers' shared egress IPs (HTTP 403 on fapi.binance.com, HTTP 451 on
// api.binance.com — confirmed 2026-07 via ingest_state.last_status, and a
// long-documented block against cloud/datacenter traffic in general, not
// specific to this account). CoinGecko's public API is built for
// third-party/bot consumption and itself aggregates Binance's funding
// rate/OI server-side, so this Worker never talks to Binance directly.
//
// Each `parse*` function is a pure function taking a raw API response and
// returning normalized rows — no fetch, no D1 — so it can be unit-tested
// against a recorded fixture without a network or database (docs/11 §2).

import { recordWrites, upsertCandles, upsertLatestSnapshot, upsertMetric } from "../db.js";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson } from "./types.js";

export interface BinanceInstrument {
  instrumentId: string;
  symbol: string;
  base: string;
  isFutures: boolean;
}

const FUT_BASE = "https://fapi.binance.com"; // kept only as a documentation marker of what data this instrument represents
const SPOT_BASE = "https://api.binance.com";

export const BINANCE_INSTRUMENTS: BinanceInstrument[] = [
  { instrumentId: "BTCUSDT.BINANCE.PERP", symbol: "BTCUSDT", base: FUT_BASE, isFutures: true },
  { instrumentId: "BTCUSDT.BINANCE.SPOT", symbol: "BTCUSDT", base: SPOT_BASE, isFutures: false },
  { instrumentId: "ETHUSDT.BINANCE.PERP", symbol: "ETHUSDT", base: FUT_BASE, isFutures: true }
];

const COINGECKO_ID_BY_BASE: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum" };

function baseAsset(symbol: string): string {
  return symbol.replace("USDT", "");
}

export type SimplePriceResponse = Record<string, { usd: number; last_updated_at: number }>;

export interface PriceRow {
  instrumentId: string;
  price: number;
  ts: number;
}

/** One CoinGecko price point fans out to every instrument sharing that base asset (BTC perp + BTC spot both get the same USD price). */
export function parseSimplePrice(raw: SimplePriceResponse, instruments: BinanceInstrument[]): PriceRow[] {
  return instruments.flatMap((inst) => {
    const geckoId = COINGECKO_ID_BY_BASE[baseAsset(inst.symbol)];
    const point = geckoId ? raw[geckoId] : undefined;
    if (!point) return [];
    return [{ instrumentId: inst.instrumentId, price: point.usd, ts: point.last_updated_at * 1000 }];
  });
}

/** Fetches current USD price for every distinct base asset in one request (docs/13 §1: 1 subrequest instead of one per instrument). */
export function makeCoinGeckoPriceAdapter(instruments: BinanceInstrument[]): Adapter {
  const streamId = "coingecko:simple_price:BTC,ETH";
  const ids = [...new Set(instruments.map((i) => COINGECKO_ID_BY_BASE[baseAsset(i.symbol)]))].join(",");
  return {
    sourceId: "coingecko",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`;
      const raw = await fetchJson<SimplePriceResponse>(url);
      const rows = parseSimplePrice(raw, instruments);
      // docs/02: candles table expects OHLC; a spot-price point is stored as a
      // degenerate (open=high=low=close) 1m bar rather than a true 1m candle,
      // since CoinGecko's free tier has no 1m OHLC endpoint.
      await upsertCandles(
        env,
        rows.map((row) => ({
          instrument_id: row.instrumentId,
          tf: "1m" as const,
          ts: row.ts,
          open: row.price,
          high: row.price,
          low: row.price,
          close: row.price,
          volume: 0,
          quote_volume: null,
          taker_buy_volume: null,
          trades: null
        }))
      );
      // Sequential by design (docs/01 index.ts convention): keeps D1 writes
      // within a single tick predictable rather than a correctness concern.
      /* eslint-disable no-await-in-loop */
      for (const row of rows) {
        await upsertLatestSnapshot(env, `candle:1m:${row.instrumentId}`, {
          v: row.price,
          ts: row.ts,
          ingested_at: Date.now()
        });
      }
      /* eslint-enable no-await-in-loop */
      const last = rows.at(-1);
      return { streamId, rowsWritten: rows.length, watermarkTs: last?.ts ?? Date.now() };
    }
  };
}

export interface DerivativesTicker {
  market: string;
  symbol: string;
  contract_type: string;
  funding_rate: number | null;
  open_interest: number | null;
  last_traded_at: number;
}

export interface DerivRow {
  instrumentId: string;
  symbol: string;
  fundingRate: number | null;
  openInterestUsd: number | null;
  ts: number;
}

/** Picks the Binance USDT-margined perpetual entry for each instrument out of CoinGecko's full cross-exchange derivatives list. */
export function parseDerivatives(raw: DerivativesTicker[], instruments: BinanceInstrument[]): DerivRow[] {
  const futuresInstruments = instruments.filter((i) => i.isFutures);
  return futuresInstruments.flatMap((inst) => {
    const entry = raw.find(
      (t) =>
        t.contract_type === "perpetual" &&
        t.symbol === inst.symbol &&
        /binance/i.test(t.market) &&
        !/coin-m|coin margined/i.test(t.market)
    );
    if (!entry) return [];
    return [
      {
        instrumentId: inst.instrumentId,
        symbol: inst.symbol,
        fundingRate: entry.funding_rate,
        openInterestUsd: entry.open_interest,
        ts: entry.last_traded_at * 1000
      }
    ];
  });
}

/** Fetches funding rate + open interest for every futures instrument in one request instead of two per instrument. */
export function makeCoinGeckoDerivativesAdapter(instruments: BinanceInstrument[]): Adapter {
  const streamId = "coingecko:derivatives:binance_perps";
  return {
    sourceId: "coingecko",
    streamId,
    requestBudget: 1,
    async run(env): Promise<AdapterRunResult> {
      const url = "https://api.coingecko.com/api/v3/derivatives";
      const raw = await fetchJson<DerivativesTicker[]>(url);
      const rows = parseDerivatives(raw, instruments);
      // Sequential by design (docs/01 index.ts convention): keeps D1 writes
      // within a single tick predictable rather than a correctness concern.
      /* eslint-disable no-await-in-loop */
      for (const row of rows) {
        if (row.fundingRate !== null) {
          await upsertMetric(env, `deriv.predicted_funding.binance.${row.symbol}`, row.ts, row.fundingRate, {});
          await upsertLatestSnapshot(env, `funding:binance:${row.symbol}`, {
            v: row.fundingRate,
            ts: row.ts,
            ingested_at: Date.now()
          });
        }
        if (row.openInterestUsd !== null) {
          await env.DB.prepare(
            `INSERT INTO open_interest (instrument_id, ts, oi_base, oi_usd, ingested_at)
             VALUES (?1, ?2, NULL, ?3, ?4)
             ON CONFLICT (instrument_id, ts) DO UPDATE SET oi_usd = excluded.oi_usd, ingested_at = excluded.ingested_at`
          )
            .bind(row.instrumentId, row.ts, row.openInterestUsd, Date.now())
            .run();
          await recordWrites(env, "d1_writes", 1);
          await upsertLatestSnapshot(env, `oi:binance:${row.symbol}`, {
            v: row.openInterestUsd,
            ts: row.ts,
            ingested_at: Date.now()
          });
        }
      }
      /* eslint-enable no-await-in-loop */
      const last = rows.at(-1);
      return { streamId, rowsWritten: rows.length, watermarkTs: last?.ts ?? Date.now() };
    }
  };
}
