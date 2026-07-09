// Explorer's client-side query engine (docs/06 SCR-04 Explorer tab, docs/15
// SONNET-8). DuckDB-WASM runs entirely in the browser's WASM sandbox, so
// every query here executes against the user's own machine -- there is no
// server-side SQL surface, and free-text WHERE clauses from the Explorer UI
// carry no injection risk (docs/01 §3.3 "サーバ計算なしで返す").
//
// Files are fetched whole from GET /api/v1/lake/{key} (docs/08 "Lake
// パススルー") via the main thread's own `fetch` and handed to DuckDB as an
// in-memory buffer (`registerFileBuffer`) -- see the 2026-07 note below on
// why this replaced the original registerFileURL/httpfs approach.

import * as duckdb from "@duckdb/duckdb-wasm";

let dbPromise: Promise<duckdb.AsyncDuckDB> | undefined;

// DuckDB-WASM's wasm binaries (30MB+ uncompressed) exceed Cloudflare
// Workers' 25 MiB static-asset limit, so they can't ship in our own
// dist/ -- loaded from jsdelivr's CDN at runtime instead, same as any
// other duckdb-wasm consumer app. The worker script is cross-origin, so
// it's wrapped in a same-origin blob that `importScripts` it (the
// standard duckdb-wasm pattern for CDN-hosted bundles).
function getDb(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= (async () => {
    try {
      const bundles = duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(bundles);
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
      );
      const worker = new Worker(workerUrl);
      // A failed CDN fetch inside the worker (e.g. importScripts 404/network
      // error) surfaces as an uncaught worker error, not a rejection of
      // instantiate() below -- without this race, that failure mode hangs
      // forever instead of reporting an error.
      const workerError = new Promise<never>((_, reject) => {
        worker.addEventListener(
          "error",
          (e) => reject(new Error(e.message || "DuckDB worker failed to load")),
          { once: true }
        );
      });
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await Promise.race([db.instantiate(bundle.mainModule, bundle.pthreadWorker), workerError]);
      URL.revokeObjectURL(workerUrl);
      return db;
    } catch (e) {
      dbPromise = undefined;
      throw e;
    }
  })();
  return dbPromise;
}

const registeredKeys = new Set<string>();

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// `key` doubles as both the R2 object key and the virtual filename DuckDB
// reads `read_parquet('{key}')` from -- registered once per key per page
// load since re-registering is a no-op cost we'd rather just avoid.
//
// 2026-07: switched from `registerFileURL` (DuckDB-WASM's httpfs doing lazy
// Range reads) to fetching the whole file and using `registerFileBuffer`.
// The URL approach kept failing with "Failed to open file" in real
// browsers because DuckDB-WASM's httpfs doesn't use `fetch` for its Range
// reads at all -- it's compiled C++ calling synchronous `XMLHttpRequest`
// (confirmed in the shipped `duckdb-browser-eh.worker.js`), so the earlier
// same-origin `credentials: "include"` patch on `self.fetch` never touched
// that code path. Fetching through the main thread's own `fetch`
// (identical to api/client.ts, already proven to work) avoids DuckDB-WASM's
// internal HTTP layer entirely -- tradeoff is a full download instead of a
// partial one, acceptable for this app's Parquet file sizes (docs/13 §2.3).
export async function queryLakeFile<T = Record<string, unknown>>(key: string, sql: string): Promise<T[]> {
  const db = await getDb();
  if (!registeredKeys.has(key)) {
    const encodedPath = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const res = await fetch(`${location.origin}/api/v1/lake/${encodedPath}`, { credentials: "include" });
    if (!res.ok) throw new Error(`Failed to fetch lake file '${key}': HTTP ${res.status}`);
    const buffer = new Uint8Array(await res.arrayBuffer());
    await db.registerFileBuffer(key, buffer);
    registeredKeys.add(key);
  }
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    return result.toArray().map((row) => row.toJSON() as T);
  } finally {
    await conn.close();
  }
}
