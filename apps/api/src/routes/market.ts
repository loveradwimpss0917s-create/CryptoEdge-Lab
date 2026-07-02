// Market snapshot routes (docs/08 "Market / Data"). Reads exclusively from
// `latest_snapshots` — a single-row-per-key table maintained by the ingest
// Worker — so this is always a single cheap D1 read (docs/01 §4.2, KV
// snapshot substitute).

import { Hono } from "hono";
import type { Env } from "../env.js";

export const marketRoute = new Hono<{ Bindings: Env }>();

const OVERVIEW_KEYS = [
  "candle:1m:BTCUSDT.BINANCE.PERP",
  "candle:1m:BTCUSDT.BINANCE.SPOT",
  "funding:binance:BTCUSDT",
  "oi:binance:BTCUSDT",
  "dvol:BTC",
  "fear_greed"
];

marketRoute.get("/overview", async (c) => {
  const placeholders = OVERVIEW_KEYS.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await c.env.DB.prepare(
    `SELECT key, value, updated_at FROM latest_snapshots WHERE key IN (${placeholders})`
  )
    .bind(...OVERVIEW_KEYS)
    .all<{ key: string; value: string; updated_at: number }>();

  const snapshot: Record<string, unknown> = {};
  for (const row of results ?? []) {
    snapshot[row.key] = { ...JSON.parse(row.value), updated_at: row.updated_at };
  }
  return c.json({ snapshot });
});
