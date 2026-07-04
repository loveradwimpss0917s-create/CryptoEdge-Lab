// SCR-02 Edge Board (docs/06 §3), lifecycle kanban + Readiness view
// (docs/06 §7, 2026-07 design). V1 slice: Lifecycle + Readiness tabs only
// — the Portfolio tab (correlation heatmap, effective independent count)
// needs edge_correlations data that Discovery/EEP runs haven't populated
// yet in this pass (docs/09 P2).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { EDGE_STATUSES, READINESS_STATES, type ReadinessState } from "@cryptoedge/schema";
import { api, type EdgeSummary } from "../../api/client";
import { nextActionLabel, READINESS_STATE_BADGE_CLASS, READINESS_STATE_LABEL, STATUS_LABEL } from "../../lib/labels";

function groupByStatus(edges: EdgeSummary[]): Record<string, EdgeSummary[]> {
  const groups: Record<string, EdgeSummary[]> = {};
  for (const status of EDGE_STATUSES) groups[status] = [];
  for (const edge of edges) {
    (groups[edge.status] ??= []).push(edge);
  }
  return groups;
}

function groupByReadiness(edges: EdgeSummary[]): Record<ReadinessState, EdgeSummary[]> {
  const groups = Object.fromEntries(READINESS_STATES.map((s) => [s, [] as EdgeSummary[]])) as unknown as Record<
    ReadinessState,
    EdgeSummary[]
  >;
  for (const edge of edges) {
    if (edge.readiness) groups[edge.readiness.state].push(edge);
  }
  return groups;
}

function ReadinessChip({ edge }: { edge: EdgeSummary }) {
  if (!edge.readiness) return null;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${READINESS_STATE_BADGE_CLASS[edge.readiness.state]}`}
    >
      {READINESS_STATE_LABEL[edge.readiness.state]}
    </span>
  );
}

function EdgeCard({ edge }: { edge: EdgeSummary }) {
  return (
    <Link
      to="/edges/$edgeId"
      params={{ edgeId: edge.edge_id }}
      className="block rounded border border-slate-800 bg-slate-950 p-2 text-sm hover:border-slate-600"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">{edge.title}</div>
        <ReadinessChip edge={edge} />
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
        <span>{edge.category}</span>
        {edge.pdf_ref && <span className="rounded bg-slate-800 px-1">{edge.pdf_ref}</span>}
      </div>
    </Link>
  );
}

function LifecycleView({ edges }: { edges: EdgeSummary[] }) {
  const groups = groupByStatus(edges);
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {EDGE_STATUSES.map((status) => (
        <div key={status} className="w-64 shrink-0 rounded border border-slate-800 bg-slate-900/50">
          <div className="border-b border-slate-800 px-3 py-2 text-sm font-medium">
            {STATUS_LABEL[status]}
            <span className="ml-1 text-slate-500">({groups[status]?.length ?? 0})</span>
          </div>
          <div className="space-y-2 p-2">
            {groups[status]?.map((edge) => <EdgeCard key={edge.edge_id} edge={edge} />)}
            {groups[status]?.length === 0 && <div className="p-2 text-xs text-slate-600">なし</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReadinessView({ edges }: { edges: EdgeSummary[] }) {
  const groups = groupByReadiness(edges);
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {READINESS_STATES.map((state) => {
        const columnEdges = groups[state];
        const sample = columnEdges[0]?.readiness;
        return (
          <div key={state} className="w-72 shrink-0 rounded border border-slate-800 bg-slate-900/50">
            <div className="border-b border-slate-800 px-3 py-2">
              <div className="text-sm font-medium">
                {READINESS_STATE_LABEL[state]}
                <span className="ml-1 text-slate-500">({columnEdges.length})</span>
              </div>
              {sample && <div className="mt-1 text-[11px] text-slate-500">{nextActionLabel(sample)}</div>}
            </div>
            <div className="space-y-2 p-2">
              {columnEdges.map((edge) => (
                <Link
                  key={edge.edge_id}
                  to="/edges/$edgeId"
                  params={{ edgeId: edge.edge_id }}
                  className="block rounded border border-slate-800 bg-slate-950 p-2 text-sm hover:border-slate-600"
                >
                  <div className="font-medium">{edge.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{edge.category}</div>
                </Link>
              ))}
              {columnEdges.length === 0 && <div className="p-2 text-xs text-slate-600">なし</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EdgeBoardScreen() {
  const search = useSearch({ from: "/board" });
  const navigate = useNavigate({ from: "/board" });
  const [tab, setTab] = useState<"lifecycle" | "readiness">(search.readiness ? "readiness" : "lifecycle");
  const [readinessFilter, setReadinessFilter] = useState<ReadinessState | "">(
    (search.readiness as ReadinessState | undefined) ?? ""
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ["edges"],
    queryFn: () => api.listEdges()
  });

  const filteredEdges = useMemo(() => {
    if (!data) return [];
    if (!readinessFilter) return data.edges;
    return data.edges.filter((e) => e.readiness?.state === readinessFilter);
  }, [data, readinessFilter]);

  function updateReadinessFilter(value: ReadinessState | "") {
    setReadinessFilter(value);
    void navigate({ search: value ? { readiness: value } : {} });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">エッジボード</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-slate-800 text-xs">
            <button
              onClick={() => setTab("lifecycle")}
              className={`px-3 py-1 ${tab === "lifecycle" ? "bg-slate-700 text-slate-100" : "text-slate-400"}`}
            >
              Lifecycle
            </button>
            <button
              onClick={() => setTab("readiness")}
              className={`px-3 py-1 ${tab === "readiness" ? "bg-slate-700 text-slate-100" : "text-slate-400"}`}
            >
              Readiness
            </button>
          </div>
          <select
            value={readinessFilter}
            onChange={(e) => updateReadinessFilter(e.target.value as ReadinessState | "")}
            className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-300"
          >
            <option value="">readiness: すべて</option>
            {READINESS_STATES.map((s) => (
              <option key={s} value={s}>
                {READINESS_STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {isLoading && <p className="text-slate-400">読み込み中…</p>}
      {error && <p className="text-reject">エッジの読み込みに失敗しました。</p>}
      {data && tab === "lifecycle" && <LifecycleView edges={filteredEdges} />}
      {data && tab === "readiness" && <ReadinessView edges={filteredEdges} />}
    </div>
  );
}
