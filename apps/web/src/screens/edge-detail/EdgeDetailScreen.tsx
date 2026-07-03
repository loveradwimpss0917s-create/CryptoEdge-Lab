// SCR-03 Edge Dossier (docs/06 §3). V1 slice: the Thesis tab only —
// Evidence/Runs/Paper/Versions/Related tabs need eval_metrics, verdicts,
// and paper_signals data that only exists once EEP runs have executed
// against seeded Edges (docs/09 P0 "全 tier の収集が7日間無人で稼働").

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { EDGE_TRANSITION_GRAPH, type EdgeStatus } from "@cryptoedge/schema";
import { api } from "../../api/client";
import { STATUS_LABEL } from "../../lib/labels";

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

  if (isLoading) return <p className="text-slate-400">読み込み中…</p>;
  if (error || !data) return <p className="text-reject">エッジの読み込みに失敗しました。</p>;

  const { edge } = data;
  const evidence = edge.evidence ? (JSON.parse(edge.evidence) as { kind: string; ref: string; note?: string }[]) : [];
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
        <section className="rounded border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-medium text-slate-400">現在のバージョン</h2>
          <pre className="mt-1 overflow-x-auto text-xs text-slate-300">
            {JSON.stringify(data.current_version, null, 2)}
          </pre>
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
