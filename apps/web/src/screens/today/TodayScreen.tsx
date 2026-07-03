// SCR-01 Today (docs/06 §3). Minimal V1 slice: the market snapshot strip.
// The Action Queue / AI briefing panels are follow-up work (docs/09 P1) —
// they depend on ai_outputs and jobs data this pass doesn't yet surface.

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { formatSnapshotValue, formatUtcTimestamp } from "../../lib/format";

export function TodayScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["market-overview"],
    queryFn: api.marketOverview,
    refetchInterval: 30_000 // docs/01 §5: polling, no SSE in V1
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
    </div>
  );
}
