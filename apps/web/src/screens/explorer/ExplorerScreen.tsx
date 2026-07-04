// Explorer 最小版 (docs/06 SCR-04 Explorer タブ, docs/15 SONNET-8): R2
// Parquet カタログ選択 → 条件式 (WHERE句) → 分布図。DuckDB-WASM がブラウザ
// 内で直接読むため、ここでのクエリはすべてクライアント側で完結する
// (docs/01 §3.3 "サーバ計算なしで返す")。

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { escapeSqlLiteral, queryLakeFile } from "../../lib/duckdb-lake";

interface ColumnInfo {
  name: string;
  type: string;
}

interface Stats {
  n: number;
  min: number;
  max: number;
  avg: number;
  stddev: number | null;
}

interface HistogramBucket {
  bucket: number;
  count: number;
}

const NUMERIC_TYPE_HINTS = ["INT", "DOUBLE", "FLOAT", "DECIMAL", "REAL", "NUMERIC", "HUGEINT"];
const BUCKET_COUNT = 20;

function isNumericType(type: string): boolean {
  const upper = type.toUpperCase();
  return NUMERIC_TYPE_HINTS.some((hint) => upper.includes(hint));
}

export function ExplorerScreen() {
  const {
    data: catalog,
    isLoading: catalogLoading,
    error: catalogError
  } = useQuery({ queryKey: ["lake-catalog"], queryFn: api.lakeCatalog });

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [whereClause, setWhereClause] = useState("");
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [histogram, setHistogram] = useState<HistogramBucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  async function handleSelectDataset(key: string) {
    setSelectedKey(key);
    setColumns(null);
    setSelectedColumn(null);
    setStats(null);
    setHistogram(null);
    setRowCount(null);
    setQueryError(null);
    setLoading(true);
    try {
      const rows = await queryLakeFile<{ column_name: string; column_type: string }>(
        key,
        `DESCRIBE SELECT * FROM read_parquet('${escapeSqlLiteral(key)}')`
      );
      const cols = rows.map((r) => ({ name: r.column_name, type: r.column_type }));
      setColumns(cols);
      setSelectedColumn(cols.find((c) => isNumericType(c.type))?.name ?? null);
    } catch (e) {
      setQueryError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runQuery() {
    if (!selectedKey) return;
    setLoading(true);
    setQueryError(null);
    try {
      const escapedKey = escapeSqlLiteral(selectedKey);
      const whereSql = whereClause.trim() ? `WHERE ${whereClause}` : "";
      const filtered = `SELECT * FROM read_parquet('${escapedKey}') ${whereSql}`;

      const countRows = await queryLakeFile<{ n: bigint | number }>(selectedKey, `SELECT count(*) AS n FROM (${filtered})`);
      setRowCount(Number(countRows[0]?.n ?? 0));

      if (!selectedColumn) {
        setStats(null);
        setHistogram(null);
        return;
      }

      const statRows = await queryLakeFile<{ n: bigint | number; mn: number; mx: number; avg: number; sd: number | null }>(
        selectedKey,
        `SELECT count(*) AS n, min(${selectedColumn}) AS mn, max(${selectedColumn}) AS mx,
                avg(${selectedColumn}) AS avg, stddev(${selectedColumn}) AS sd
         FROM (${filtered}) WHERE ${selectedColumn} IS NOT NULL`
      );
      const s = statRows[0];
      if (!s || s.mn === null || s.mx === null) {
        setStats(null);
        setHistogram(null);
        return;
      }
      const mn = Number(s.mn);
      const mx = Number(s.mx);
      setStats({ n: Number(s.n), min: mn, max: mx, avg: Number(s.avg), stddev: s.sd !== null ? Number(s.sd) : null });

      const histRows = await queryLakeFile<{ bucket: number; c: bigint | number }>(
        selectedKey,
        `SELECT
           CASE WHEN ${mx} = ${mn} THEN 0
                ELSE LEAST(${BUCKET_COUNT - 1}, CAST(FLOOR((${selectedColumn} - ${mn}) / (${mx} - ${mn}) * ${BUCKET_COUNT}) AS INTEGER))
           END AS bucket,
           count(*) AS c
         FROM (${filtered})
         WHERE ${selectedColumn} IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket`
      );
      setHistogram(histRows.map((r) => ({ bucket: Number(r.bucket), count: Number(r.c) })));
    } catch (e) {
      setQueryError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const maxCount = histogram && histogram.length > 0 ? Math.max(...histogram.map((h) => h.count)) : 1;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Explorer</h1>
      <p className="text-xs text-slate-500">
        DuckDB-WASM がブラウザ内で R2 の Parquet を直接読み、任意条件の分布をサーバ計算なしで返します (docs/06 SCR-04)。
      </p>

      {catalogLoading && <p className="text-slate-400">カタログ読み込み中…</p>}
      {catalogError && <p className="text-reject">カタログの読み込みに失敗しました。</p>}

      {catalog && (
        <div className="space-y-1">
          <label className="text-xs text-slate-500" htmlFor="dataset-select">
            データセット
          </label>
          <select
            id="dataset-select"
            className="w-full rounded border border-slate-800 bg-slate-900 p-2 text-sm text-slate-100"
            value={selectedKey ?? ""}
            onChange={(e) => {
              if (e.target.value) void handleSelectDataset(e.target.value);
            }}
          >
            <option value="" disabled>
              選択してください ({catalog.datasets.length}件)
            </option>
            {catalog.datasets.map((d) => (
              <option key={d.key} value={d.key}>
                {d.key} ({(d.size / 1024).toFixed(0)} KB)
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && !columns && <p className="text-slate-400">読み込み中…</p>}
      {queryError && !columns && <p className="text-xs text-reject">{queryError}</p>}

      {columns && (
        <div className="space-y-3 rounded border border-slate-800 bg-slate-900 p-3">
          <div className="space-y-1">
            <label className="text-xs text-slate-500" htmlFor="where-input">
              条件式 (WHERE句、省略可)
            </label>
            <input
              id="where-input"
              className="w-full rounded border border-slate-800 bg-slate-950 p-2 font-mono text-sm text-slate-100"
              placeholder="例: close > 50000 AND ts > 1700000000000"
              value={whereClause}
              onChange={(e) => setWhereClause(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-slate-500" htmlFor="column-select">
              分布を見る列
            </label>
            <select
              id="column-select"
              className="w-full rounded border border-slate-800 bg-slate-950 p-2 text-sm text-slate-100"
              value={selectedColumn ?? ""}
              onChange={(e) => setSelectedColumn(e.target.value || null)}
            >
              <option value="">(なし -- 件数のみ)</option>
              {columns
                .filter((c) => isNumericType(c.type))
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.type})
                  </option>
                ))}
            </select>
          </div>

          <button
            type="button"
            className="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-950 disabled:opacity-50"
            onClick={() => void runQuery()}
            disabled={loading}
          >
            {loading ? "実行中…" : "クエリ実行"}
          </button>

          {queryError && <p className="text-xs text-reject">{queryError}</p>}

          {rowCount !== null && <p className="text-sm text-slate-300">該当件数: {rowCount.toLocaleString()}</p>}

          {stats && (
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 sm:grid-cols-4">
              <div>
                min: <span className="text-slate-200">{stats.min}</span>
              </div>
              <div>
                max: <span className="text-slate-200">{stats.max}</span>
              </div>
              <div>
                avg: <span className="text-slate-200">{stats.avg.toFixed(4)}</span>
              </div>
              <div>
                stddev: <span className="text-slate-200">{stats.stddev !== null ? stats.stddev.toFixed(4) : "-"}</span>
              </div>
            </div>
          )}

          {histogram && histogram.length > 0 && (
            <div className="flex h-32 items-end gap-0.5">
              {histogram.map((h) => (
                <div
                  key={h.bucket}
                  className="flex-1 bg-adopt"
                  style={{ height: `${(h.count / maxCount) * 100}%` }}
                  title={`bucket ${h.bucket}: ${h.count}件`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
