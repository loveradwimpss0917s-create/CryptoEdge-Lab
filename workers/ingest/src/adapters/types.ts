// Adapter contract (docs/03 §7). Each source implements this once; the
// scheduler (schedule.ts) is the only thing that decides *when* an adapter
// runs. `run` must stay within the Worker CPU budget (docs/01 §4.1: no
// heavy loops) — a handful of fetches + a bounded parse + a batched D1
// write. Anything heavier belongs in research-worker.

import type { Env } from "../env.js";

export interface AdapterRunResult {
  streamId: string;
  rowsWritten: number;
  watermarkTs: number;
}

export interface Adapter {
  /** Matches data_sources.source_id (docs/02, seeded in migrations/0002). */
  sourceId: string;
  /** Stream identifier, e.g. `binance_rest:klines_1m:BTCUSDT.BINANCE.PERP` (docs/02 ingest_state.stream_id). */
  streamId: string;
  /** Approximate number of subrequests one `run()` call issues — used to keep a tick's fetch budget under 40 (docs/13 §1). */
  requestBudget: number;
  run(env: Env): Promise<AdapterRunResult>;
}

/** Thrown by adapters on a recoverable failure; the scheduler enqueues an ingest_tasks retry. */
export class AdapterFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterFetchError";
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new AdapterFetchError(`${url} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
