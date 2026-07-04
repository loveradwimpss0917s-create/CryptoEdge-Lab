// SCR-01 Today (docs/06 §3). Minimal V1 slice: the market snapshot strip +
// Research Readiness summary (docs/06 §7.6, 2026-07 design). The Action
// Queue / AI briefing panels are still follow-up work (docs/09 P1) — they
// depend on ai_outputs and jobs data this pass doesn't yet surface.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, type QuotaRow, type ReadinessState } from "../../api/client";
import { formatSnapshotValue, formatUtcTimestamp } from "../../lib/format";
import { QUOTA_RESOURCE_LABEL } from "../../lib/labels";

const BLOCKED_ROW_LABEL: Record<"build_pending" | "signal_spec_pending" | "feature_pending" | "data_pending", string> =
  {
    build_pending: "実装待ち",
    signal_spec_pending: "SignalSpec待ち",
    feature_pending: "FEATURE待ち",
    data_pending: "DATA待ち"
  };

const BLOCKED_ROW_STATE: Record<keyof typeof BLOCKED_ROW_LABEL, ReadinessState> = {
  build_pending: "BUILD_PENDING",
  signal_spec_pending: "SIGNAL_SPEC_PENDING",
  feature_pending: "FEATURE_PENDING",
  data_pending: "DATA_PENDING"
};

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

  const { data: readinessSummary } = useQuery({
    queryKey: ["readiness-summary"],
    queryFn: api.readinessSummary,
    refetchInterval: 60_000
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">今日</h1>
      {readinessSummary && (
        <div className="space-y-3 rounded border border-slate-800 bg-slate-900 p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-slate-400">🧭 RESEARCH READINESS</h2>
            <Link
              to="/board"
              search={{ readiness: "READY" }}
              className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-500"
            >
              今すぐ評価可能: {readinessSummary.ready_count}件 →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {(Object.keys(BLOCKED_ROW_LABEL) as (keyof typeof BLOCKED_ROW_LABEL)[]).map((key) => (
              <Link
                key={key}
                to="/board"
                search={{ readiness: BLOCKED_ROW_STATE[key] }}
                className="rounded border border-slate-800 bg-slate-950 p-2 hover:border-slate-600"
              >
                <div className="text-slate-500">{BLOCKED_ROW_LABEL[key]}</div>
                <div className="font-mono text-lg">{readinessSummary.blocked_breakdown[key]}</div>
              </Link>
            ))}
          </div>
          <div className="text-xs text-slate-500">
            レビュー待ち: SCREEN {readinessSummary.review_pending.screen} / FULL {readinessSummary.review_pending.full}
          </div>
        </div>
      )}
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
