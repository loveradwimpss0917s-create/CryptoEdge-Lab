// SCR-05 Data Health (docs/06 §3, docs/15 SONNET-4). V1 slice: the
// source×stream quality-score grid + open issues list from the wireframe,
// plus a manual [解決] button per issue (docs/19 S-02) -- most issues
// close themselves automatically when their stream next succeeds
// (workers/ingest touchIngestState), this is for ones that won't (a
// permanently retired source, or a human who's already investigated).
// [手動リフィル実行] / [ソース無効化] are still not implemented -- both need
// different new mutating endpoints this pass doesn't add (docs/06 SCR-05
// wireframe still names them as follow-up work).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type StreamHealth } from "../../api/client";
import { formatUtcTimestamp } from "../../lib/format";

function qualityColorClass(score: number): string {
  if (score >= 0.99) return "bg-adopt text-slate-950";
  if (score >= 0.8) return "bg-watch text-slate-950";
  return "bg-reject text-slate-950";
}

function StreamCell({ stream }: { stream: StreamHealth }) {
  const issueCount = stream.open_issues.critical + stream.open_issues.warn + stream.open_issues.info;
  return (
    <div className="space-y-1 rounded border border-slate-800 bg-slate-950 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-slate-300" title={stream.stream_id}>
          {stream.stream_id}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${qualityColorClass(stream.quality_score)}`}>
          {(stream.quality_score * 100).toFixed(0)}%
        </span>
      </div>
      <div className="text-slate-600">
        {stream.last_run_at ? formatUtcTimestamp(stream.last_run_at) : "未実行"}
        {stream.consecutive_errors > 0 && <span className="text-reject"> ・連続エラー {stream.consecutive_errors}</span>}
        {issueCount > 0 && <span className="text-watch"> ・open issue {issueCount}件</span>}
      </div>
    </div>
  );
}

export function DataHealthScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["data-health"],
    queryFn: api.dataHealth,
    refetchInterval: 60_000
  });
  const resolveIssue = useMutation({
    mutationFn: (issueId: number) => api.resolveDqIssue(issueId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["data-health"] })
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Data Health</h1>
        {data?.overall_quality_score !== null && data?.overall_quality_score !== undefined && (
          <span className={`rounded px-2 py-1 text-sm font-medium ${qualityColorClass(data.overall_quality_score)}`}>
            全体品質スコア: {(data.overall_quality_score * 100).toFixed(1)}%
          </span>
        )}
      </div>
      {isLoading && <p className="text-slate-400">読み込み中…</p>}
      {error && <p className="text-reject">Data Healthの読み込みに失敗しました。</p>}
      {data && (
        <div className="space-y-3">
          {data.sources
            .filter((s) => s.status !== "disabled")
            .map((source) => (
              <section key={source.source_id} className="rounded border border-slate-800 bg-slate-900 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-medium">{source.name}</h2>
                  <span className="text-xs text-slate-500">{source.source_id}</span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">{source.status}</span>
                </div>
                {source.streams.length === 0 ? (
                  <p className="text-xs text-slate-600">まだ収集が実行されていません</p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {source.streams.map((stream) => (
                      <StreamCell key={stream.stream_id} stream={stream} />
                    ))}
                  </div>
                )}
              </section>
            ))}
          {data.sources.some((s) => s.status === "disabled") && (
            <details className="rounded border border-slate-800 bg-slate-900/50 p-3">
              <summary className="cursor-pointer text-xs text-slate-500">
                無効化済みソース ({data.sources.filter((s) => s.status === "disabled").length}件、恒久停止 — 品質スコアに含まれません)
              </summary>
              <div className="mt-2 space-y-2">
                {data.sources
                  .filter((s) => s.status === "disabled")
                  .map((source) => (
                    <div key={source.source_id} className="text-xs text-slate-600">
                      <span className="text-slate-400">{source.name}</span> ({source.source_id}) — {source.streams.length}ストリーム
                    </div>
                  ))}
              </div>
            </details>
          )}
        </div>
      )}
      {data && data.open_issues.length > 0 && (
        <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3">
          <h2 className="text-sm font-medium text-slate-400">Open Issues</h2>
          <ul className="space-y-1 text-xs">
            {data.open_issues.map((issue) => (
              <li key={issue.issue_id} className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    issue.severity === "critical"
                      ? "bg-reject text-slate-950"
                      : issue.severity === "warn"
                        ? "bg-watch text-slate-950"
                        : "bg-slate-700 text-slate-100"
                  }`}
                >
                  {issue.severity}
                </span>
                <span className="text-slate-300">{issue.rule_id}</span>
                <span className="text-slate-500">{issue.stream_id}</span>
                <span className="text-slate-600">{formatUtcTimestamp(issue.detected_at)}</span>
                <button
                  type="button"
                  className="ml-auto rounded border border-slate-700 px-2 py-0.5 text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:opacity-50"
                  disabled={resolveIssue.isPending && resolveIssue.variables === issue.issue_id}
                  onClick={() => resolveIssue.mutate(issue.issue_id)}
                >
                  {resolveIssue.isPending && resolveIssue.variables === issue.issue_id ? "解決中…" : "解決"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
