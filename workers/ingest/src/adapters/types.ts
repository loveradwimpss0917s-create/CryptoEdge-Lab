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

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_RETRY_AFTER_MS = 1000;

/** Parses a `Retry-After` header (seconds, or an HTTP-date) into a millisecond delay. */
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

/**
 * A random 300-800ms gap to space out same-tick calls to one source
 * (2026-07 review, Task 6): Cloudflare Workers share an egress IP pool
 * across countless unrelated Workers, so a public API's per-IP rate limit
 * can trip under light traffic from this project alone even without an
 * actual burst on our side.
 */
export async function jitterDelay(minMs = 300, maxMs = 800): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 429) {
    // One retry, honoring the source's own back-off hint when given
    // (2026-07 review, Task 6) — most rate-limit windows this project hits
    // are sub-second, so a single wait-and-retry clears the transient case
    // without adding a second full ingest_tasks retry cycle for it.
    await sleep(parseRetryAfterMs(res.headers.get("retry-after")) ?? DEFAULT_RETRY_AFTER_MS);
    const retryRes = await fetch(url, init);
    if (!retryRes.ok) {
      throw new AdapterFetchError(`${url} -> HTTP ${retryRes.status} (after 429 retry)`);
    }
    return (await retryRes.json()) as T;
  }
  if (!res.ok) {
    throw new AdapterFetchError(`${url} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
