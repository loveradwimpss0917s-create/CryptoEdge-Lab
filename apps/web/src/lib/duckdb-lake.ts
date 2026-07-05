// Explorer's client-side query engine (docs/06 SCR-04 Explorer tab, docs/15
// SONNET-8). DuckDB-WASM runs entirely in the browser's WASM sandbox, so
// every query here executes against the user's own machine -- there is no
// server-side SQL surface, and free-text WHERE clauses from the Explorer UI
// carry no injection risk (docs/01 §3.3 "サーバ計算なしで返す").
//
// Files are read straight off GET /api/v1/lake/{key} (docs/08 "Lake
// パススルー"), which supports Range requests, so DuckDB-WASM's httpfs only
// pulls the Parquet footer/row-groups it actually needs instead of
// downloading the whole file.

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
export async function queryLakeFile<T = Record<string, unknown>>(key: string, sql: string): Promise<T[]> {
  const db = await getDb();
  if (!registeredKeys.has(key)) {
    // Safari's URL parser (unlike Chromium's) rejects a root-relative path
    // like "/api/v1/lake/..." here with "SyntaxError: The string did not
    // match the expected pattern" -- duckdb-wasm needs a fully qualified
    // URL, not one resolved implicitly against the page's own location.
    const encodedPath = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    await db.registerFileURL(key, `${location.origin}/api/v1/lake/${encodedPath}`, duckdb.DuckDBDataProtocol.HTTP, false);
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
