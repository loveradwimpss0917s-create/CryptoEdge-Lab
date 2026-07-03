// SCR-03 Edge Dossier (docs/06 §3). V1 slice: Thesis + a flat 評価履歴
// (run/verdict/wf:oos指標) section, not the full tabbed Evidence/Runs/
// Paper/Versions/Related layout — Paper/Versions/Related still need
// paper_signals data that only exists once EEP runs have executed against
// seeded Edges (docs/09 P0 "全 tier の収集が7日間無人で稼働"). 評価履歴は
// 2026-07 レビュー Task 8 で追加。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { EDGE_TRANSITION_GRAPH, type EdgeStatus } from "@cryptoedge/schema";
import { api, type RunSummary } from "../../api/client";
import { formatUtcTimestamp } from "../../lib/format";
import { STATUS_LABEL, VERDICT_CHECK_LABEL, VERDICT_LABEL } from "../../lib/labels";

const VERDICT_BADGE_CLASS: Record<"ADOPT" | "WATCH" | "REJECT", string> = {
  ADOPT: "bg-adopt text-slate-950",
  WATCH: "bg-watch text-slate-950",
  REJECT: "bg-reject text-slate-950"
};

function RunHistoryEntry({ run }: { run: RunSummary }) {
  const metricEntries: [string, number | null][] = [
    ["EV", run.metrics.ev_bps],
    ["Sharpe", run.metrics.sharpe],
    ["DSR", run.metrics.dsr],
    ["p_perm", run.metrics.p_perm]
  ];

  return (
    <div className="space-y-2 border-t border-slate-800 pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {run.verdict ? (
          <span className={`rounded px-2 py-0.5 font-medium ${VERDICT_BADGE_CLASS[run.verdict.verdict]}`}>
            {VERDICT_LABEL[run.verdict.verdict]}
          </span>
        ) : (
          <span className="rounded bg-slate-800 px-2 py-0.5 font-medium text-slate-400">未評価</span>
        )}
        <span className="text-slate-500">{run.run_kind}</span>
        <span className="text-slate-600">{run.finished_at ? formatUtcTimestamp(run.finished_at) : run.status}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 sm:grid-cols-4">
        {metricEntries.map(([label, value]) => (
          <div key={label}>
            {label}: {value ?? "—"}
          </div>
        ))}
      </div>
      {run.verdict && run.verdict.reasons.length > 0 && (
        <ul className="space-y-1 text-xs">
          {run.verdict.reasons.map((reason) => (
            <li key={reason.check} className="flex items-start gap-1.5">
              <span className={reason.passed ? "text-adopt" : "text-reject"}>{reason.passed ? "✓" : "✗"}</span>
              <span className="text-slate-300">{VERDICT_CHECK_LABEL[reason.check] ?? reason.check}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EdgeDetailScreen() {
  const { edgeId } = useParams({ from: "/edges/$edgeId" });
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["edge", edgeId],
    queryFn: () => api.getEdge(edgeId)
  });

  const transition = useMutation({
    mutationFn: (to_status: string) => api.transitionEdge(edgeId, to_status, "UIからの手動遷移"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["edge", edgeId] });
      queryClient.invalidateQueries({ queryKey: ["edges"] });
    }
  });

  // 評価トリガー (2026-07): これが無いと Edge は IDEA/CANDIDATE のまま
  // 先に進めない — screen/full run が一度も走らないため、状態遷移ガード
  // (docs/05 §2) を満たす eval_runs/verdicts が永遠に生まれない。
  const evalTrigger = useMutation({
    mutationFn: (kind: "screen" | "full") => {
      const versionId = (data?.current_version as { version_id?: string } | null)?.version_id;
      if (!versionId) throw new Error("現在のバージョンがありません");
      return api.evalEdge(edgeId, versionId, kind);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["edge", edgeId] });
    }
  });

  if (isLoading) return <p className="text-slate-400">読み込み中…</p>;
  if (error || !data) return <p className="text-reject">エッジの読み込みに失敗しました。</p>;

  const { edge } = data;
  // edge.evidence is a free-text TEXT column (docs/02 §2.5) that's normally
  // JSON but isn't schema-enforced at the DB layer; a malformed row would
  // otherwise throw during render and take down the whole screen (2026-07
  // review, Task 7).
  let evidence: { kind: string; ref: string; note?: string }[] = [];
  let evidenceRaw: string | null = null;
  if (edge.evidence) {
    try {
      evidence = JSON.parse(edge.evidence) as { kind: string; ref: string; note?: string }[];
    } catch {
      evidenceRaw = edge.evidence;
    }
  }
  const nextStates = EDGE_TRANSITION_GRAPH[edge.status as EdgeStatus] ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">{edge.title}</h1>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-xs">{STATUS_LABEL[edge.status as EdgeStatus]}</span>
        {edge.pdf_ref && <span className="rounded bg-slate-800 px-2 py-0.5 text-xs">{edge.pdf_ref}</span>}
      </div>
      <p className="text-sm text-slate-500">{edge.category}</p>

      <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-4">
        <div>
          <h2 className="text-sm font-medium text-slate-400">仮説</h2>
          <p>{edge.hypothesis}</p>
        </div>
        <div>
          <h2 className="text-sm font-medium text-slate-400">根拠</h2>
          <p>{edge.rationale}</p>
        </div>
        {edge.counter_evidence && (
          <div>
            <h2 className="text-sm font-medium text-slate-400">反証</h2>
            <p>{edge.counter_evidence}</p>
          </div>
        )}
        {evidenceRaw && (
          <div>
            <h2 className="text-sm font-medium text-slate-400">証拠 (JSON解析失敗、生データ表示)</h2>
            <p className="whitespace-pre-wrap text-sm text-slate-300">{evidenceRaw}</p>
          </div>
        )}
        {evidence.length > 0 && (
          <div>
            <h2 className="text-sm font-medium text-slate-400">証拠</h2>
            <ul className="list-inside list-disc text-sm">
              {evidence.map((e, i) => (
                <li key={i}>
                  {e.ref}
                  {e.note ? ` — ${e.note}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {data.current_version && (
        <section className="space-y-3 rounded border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-medium text-slate-400">現在のバージョン</h2>
          <pre className="overflow-x-auto text-xs text-slate-300">
            {JSON.stringify(data.current_version, null, 2)}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => evalTrigger.mutate("screen")}
              disabled={evalTrigger.isPending}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50"
            >
              スクリーン評価を実行
            </button>
            <button
              onClick={() => evalTrigger.mutate("full")}
              disabled={evalTrigger.isPending}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50"
            >
              フル評価を実行
            </button>
          </div>
          {evalTrigger.isSuccess && (
            <p className="text-sm text-adopt">
              評価を投入しました (job_id: {evalTrigger.data.job_id})。数分後に評価履歴に反映されます。
            </p>
          )}
          {evalTrigger.isError && (
            <p className="text-sm text-reject">
              {evalTrigger.error instanceof Error ? evalTrigger.error.message : "評価の投入に失敗しました"}
            </p>
          )}
        </section>
      )}

      {data.runs.length > 0 && (
        <section className="space-y-3 rounded border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-medium text-slate-400">評価履歴 (直近{data.runs.length}件)</h2>
          {data.runs.map((run) => (
            <RunHistoryEntry key={run.run_id} run={run} />
          ))}
        </section>
      )}

      {nextStates.length > 0 && (
        <section className="flex flex-wrap gap-2">
          {nextStates.map((status) => (
            <button
              key={status}
              onClick={() => transition.mutate(status)}
              disabled={transition.isPending}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50"
            >
              → {STATUS_LABEL[status]}
            </button>
          ))}
        </section>
      )}
      {transition.isError && (
        <p className="text-sm text-reject">
          {transition.error instanceof Error ? transition.error.message : "状態遷移に失敗しました"}
        </p>
      )}
    </div>
  );
}
