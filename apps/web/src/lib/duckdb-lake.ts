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
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdbWorkerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbWorkerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

let dbPromise: Promise<duckdb.AsyncDuckDB> | undefined;

// Lazily instantiated once per page load, only when the Explorer tab is
// actually opened -- nothing to spin up server-side either way.
function getDb(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= (async () => {
    const bundles: duckdb.DuckDBBundles = {
      mvp: { mainModule: duckdbWasmMvp, mainWorker: duckdbWorkerMvp },
      eh: { mainModule: duckdbWasmEh, mainWorker: duckdbWorkerEh }
    };
    const bundle = await duckdb.selectBundle(bundles);
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
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
    await db.registerFileURL(key, `/api/v1/lake/${key}`, duckdb.DuckDBDataProtocol.HTTP, false);
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
