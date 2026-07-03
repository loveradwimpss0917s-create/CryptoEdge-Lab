// SCR-02 Edge Board (docs/06 §3), lifecycle kanban. V1 slice: the
// Lifecycle tab only — the Portfolio tab (correlation heatmap, effective
// independent count) needs edge_correlations data that Discovery/EEP
// runs haven't populated yet in this pass (docs/09 P2).

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EDGE_STATUSES } from "@cryptoedge/schema";
import { api, type EdgeSummary } from "../../api/client";
import { STATUS_LABEL } from "../../lib/labels";

function groupByStatus(edges: EdgeSummary[]): Record<string, EdgeSummary[]> {
  const groups: Record<string, EdgeSummary[]> = {};
  for (const status of EDGE_STATUSES) groups[status] = [];
  for (const edge of edges) {
    (groups[edge.status] ??= []).push(edge);
  }
  return groups;
}

export function EdgeBoardScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["edges"],
    queryFn: () => api.listEdges()
  });

  const groups = data ? groupByStatus(data.edges) : {};

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">エッジボード</h1>
      {isLoading && <p className="text-slate-400">読み込み中…</p>}
      {error && <p className="text-reject">エッジの読み込みに失敗しました。</p>}
      {data && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {EDGE_STATUSES.map((status) => (
            <div key={status} className="w-64 shrink-0 rounded border border-slate-800 bg-slate-900/50">
              <div className="border-b border-slate-800 px-3 py-2 text-sm font-medium">
                {STATUS_LABEL[status]}
                <span className="ml-1 text-slate-500">({groups[status]?.length ?? 0})</span>
              </div>
              <div className="space-y-2 p-2">
                {groups[status]?.map((edge) => (
                  <Link
                    key={edge.edge_id}
                    to="/edges/$edgeId"
                    params={{ edgeId: edge.edge_id }}
                    className="block rounded border border-slate-800 bg-slate-950 p-2 text-sm hover:border-slate-600"
                  >
                    <div className="font-medium">{edge.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                      <span>{edge.category}</span>
                      {edge.pdf_ref && <span className="rounded bg-slate-800 px-1">{edge.pdf_ref}</span>}
                    </div>
                  </Link>
                ))}
                {groups[status]?.length === 0 && <div className="p-2 text-xs text-slate-600">なし</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
