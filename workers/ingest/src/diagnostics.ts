// TEMPORARY diagnostic (docs/03 §2.1 investigation, 2026-07): both Binance
// and CoinGecko block Cloudflare Workers' shared egress IPs outright. Before
// guessing at a third replacement, this probes a curated list of candidate
// market-data hosts once and records which ones are actually reachable from
// this Worker's real network path — remove this file and its call site once
// the investigation is done.

import { upsertLatestSnapshot } from "./db.js";
import type { Env } from "./env.js";

const CANDIDATES: { name: string; url: string }[] = [
  { name: "control_example_com", url: "https://example.com/" },
  { name: "coingecko_simple_price", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd" },
  { name: "binance_fapi", url: "https://fapi.binance.com/fapi/v1/ping" },
  { name: "bybit_tickers", url: "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT" },
  { name: "okx_ticker", url: "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP" },
  { name: "coinbase_ticker", url: "https://api.exchange.coinbase.com/products/BTC-USD/ticker" },
  { name: "kraken_ticker", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD" },
  { name: "deribit_dvol", url: "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd" },
  { name: "coincap", url: "https://api.coincap.io/v2/assets/bitcoin" }
];

export async function runReachabilityDiagnostic(env: Env): Promise<void> {
  const results = await Promise.allSettled(
    CANDIDATES.map(async (c) => {
      try {
        const res = await fetch(c.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CryptoEdgeLab/1.0)" } });
        return { name: c.name, status: res.status, ok: res.ok };
      } catch (err) {
        return { name: c.name, status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
  const summary = results.map((r) => (r.status === "fulfilled" ? r.value : { name: "?", status: -1, ok: false }));
  await upsertLatestSnapshot(env, "diag:reachability", { results: summary, ts: Date.now() });
}
