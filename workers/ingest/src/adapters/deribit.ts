// Deribit public REST (docs/03 §2.1 `deribit_rest`). No auth required.
// DVOL is the core options-volatility index feeding the VRP seed edge
// (EC-013, docs/09 §3 vrp-monitor).

import { upsertLatestSnapshot } from "../db.js";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson } from "./types.js";

export interface VolatilityIndexResponse {
  result: {
    data: [number, number, number, number, number][]; // [timestamp, open, high, low, close]
  };
}

export function parseDvol(data: VolatilityIndexResponse): { hourTs: number; close: number } {
  const last = data.result.data.at(-1);
  if (!last) throw new Error("Deribit DVOL returned no data points");
  const [ts, , , , close] = last;
  return { hourTs: Math.floor(ts / 3_600_000) * 3_600_000, close };
}

export const deribitDvolAdapter: Adapter = {
  sourceId: "deribit_rest",
  streamId: "deribit_rest:dvol:BTC",
  requestBudget: 1,
  async run(env): Promise<AdapterRunResult> {
    const now = Date.now();
    const start = now - 2 * 60 * 60_000;
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${now}&resolution=3600`;
    const { hourTs, close } = parseDvol(await fetchJson<VolatilityIndexResponse>(url));

    await env.DB.prepare(
      `INSERT INTO options_surface (underlying, ts, dvol, ingested_at)
       VALUES ('BTC', ?1, ?2, ?3)
       ON CONFLICT (underlying, ts) DO UPDATE SET dvol = excluded.dvol, ingested_at = excluded.ingested_at`
    )
      .bind(hourTs, close, now)
      .run();
    await upsertLatestSnapshot(env, "dvol:BTC", { v: close, ts: hourTs, ingested_at: now });

    return { streamId: "deribit_rest:dvol:BTC", rowsWritten: 1, watermarkTs: hourTs };
  }
};
