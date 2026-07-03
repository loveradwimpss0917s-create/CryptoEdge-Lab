// SCR-01 Today (docs/06 §3). Minimal V1 slice: the market snapshot strip.
// The Action Queue / AI briefing panels are follow-up work (docs/09 P1) —
// they depend on ai_outputs and jobs data this pass doesn't yet surface.

import { useQuery } from "@tanstack/react-query";
import { api, type QuotaRow } from "../../api/client";
import { formatSnapshotValue, formatUtcTimestamp } from "../../lib/format";
import { QUOTA_RESOURCE_LABEL } from "../../lib/labels";

function quotaBarColor(ratio: number): string {
  if (ratio >= 0.8) return "bg-reject";
  if (ratio >= 0.6) return "bg-yellow-500";
  return "bg-emerald-600";
}

function QuotaBar({ row }: { row: QuotaRow }) {
  if (row.usage_ratio === null) return null;
  const pct = Math.min(row.usage_ratio, 1) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs text-slate-500">
        <span>{QUOTA_RESOURCE_LABEL[row.resource] ?? row.resource}</span>
        <span>{Math.round(row.usage_ratio * 100)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800">
        <div className={`h-1.5 rounded-full ${quotaBarColor(row.usage_ratio)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function TodayScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["market-overview"],
    queryFn: api.marketOverview,
    refetchInterval: 30_000 // docs/01 §5: polling, no SSE in V1
  });

  // 無料枠ヘッドルームは「枯渇して初めて気づく」ものではなく常設表示 (docs/12
  // §2, 2026-07 レビュー Task 7)。取得失敗はダッシュボード全体を止めるほど
  // 重要ではないので、静かに非表示にする。
  const { data: quotaData } = useQuery({
    queryKey: ["quota-overview"],
    queryFn: api.quotaOverview,
    refetchInterval: 60_000,
    retry: false
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">今日</h1>
      {isLoading && <p className="text-slate-400">市場データを読み込み中…</p>}
      {error && <p className="text-reject">市場データの読み込みに失敗しました。</p>}
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Object.entries(data.snapshot).map(([key, point]) =>
            point ? (
              <div key={key} className="rounded border border-slate-800 bg-slate-900 p-3">
                <div className="text-xs text-slate-500">{key}</div>
                <div className="text-lg font-mono">{formatSnapshotValue(key, point.v)}</div>
                <div className="text-xs text-slate-600">{formatUtcTimestamp(point.ts)}</div>
              </div>
            ) : null
          )}
          {Object.keys(data.snapshot).length === 0 && (
            <p className="col-span-full text-slate-500">
              まだデータがありません — ingest Worker が未実行か、Cron がまだ発火していません。
            </p>
          )}
        </div>
      )}
      {quotaData && quotaData.quota.some((row) => row.usage_ratio !== null) && (
        <div className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3">
          <h2 className="text-xs font-medium text-slate-400">無料枠の使用状況</h2>
          {quotaData.quota
            .filter((row) => row.usage_ratio !== null)
            .map((row) => (
              <QuotaBar key={row.resource} row={row} />
            ))}
        </div>
      )}
    </div>
  );
}
