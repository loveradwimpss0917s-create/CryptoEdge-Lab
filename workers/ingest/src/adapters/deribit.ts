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

// 24h, not just the current hour: Deribit's public API sits behind
// Cloudflare Workers' shared egress IP pool same as every other adapter
// here (docs/03 §2.1), and has had sustained multi-hour 429 outages in
// production. A window this narrow used to silently lose any hour that
// fell outside it once an outage ran longer than the window -- widening
// it means the very next successful call backfills the whole gap instead
// of only ever recovering the most recent point.
export function parseDvolPoints(data: VolatilityIndexResponse): { hourTs: number; close: number }[] {
  if (data.result.data.length === 0) throw new Error("Deribit DVOL returned no data points");
  return data.result.data.map(([ts, , , , close]) => ({
    hourTs: Math.floor(ts / 3_600_000) * 3_600_000,
    close
  }));
}

export const deribitDvolAdapter: Adapter = {
  sourceId: "deribit_rest",
  streamId: "deribit_rest:dvol:BTC",
  requestBudget: 1,
  async run(env): Promise<AdapterRunResult> {
    const now = Date.now();
    const start = now - 24 * 60 * 60_000;
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${now}&resolution=3600`;
    const points = parseDvolPoints(await fetchJson<VolatilityIndexResponse>(url));

    // Sequential by design -- D1 batch() doesn't dedupe ON CONFLICT targets
    // within a single call, and this is at most 24 rows.
    /* eslint-disable no-await-in-loop */
    for (const point of points) {
      await env.DB.prepare(
        `INSERT INTO options_surface (underlying, ts, dvol, ingested_at)
         VALUES ('BTC', ?1, ?2, ?3)
         ON CONFLICT (underlying, ts) DO UPDATE SET dvol = excluded.dvol, ingested_at = excluded.ingested_at`
      )
        .bind(point.hourTs, point.close, now)
        .run();
    }
    /* eslint-enable no-await-in-loop */

    const last = points.at(-1)!;
    await upsertLatestSnapshot(env, "dvol:BTC", { v: last.close, ts: last.hourTs, ingested_at: now });

    return { streamId: "deribit_rest:dvol:BTC", rowsWritten: points.length, watermarkTs: last.hourTs };
  }
};
