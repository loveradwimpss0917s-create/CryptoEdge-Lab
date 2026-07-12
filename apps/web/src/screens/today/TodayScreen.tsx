// SCR-01 Today (docs/06 §3). V1 slice: market snapshot strip + Research
// Readiness summary (docs/06 §7.6, 2026-07 design) + daily_briefing Pack
// display/[Copy for AI] (docs/07 §2-4, docs/15 SONNET-2/7) + Action Queue
// (docs/06 §1 item 1, docs/15 SONNET-7 V1 slice: SCREEN_DONE/FULL_DONE
// Edges + open DQ critical issues -- findings-based items are V2 scope,
// Discovery Engine not yet built).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, api, type ActionItem, type QuotaRow, type ReadinessState } from "../../api/client";
import { formatSnapshotValue, formatUtcTimestamp } from "../../lib/format";
import { QUOTA_RESOURCE_LABEL } from "../../lib/labels";

// docs/07 §4: the daily_briefing Research Pack, shown inline (収縮/展開
// 可能) with a [Copy for AI] fallback for pasting into Claude/ChatGPT/
// Gemini — no server-side AI call involved either way.
function BriefingPanel() {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const { data: pack, isLoading, error } = useQuery({
    queryKey: ["daily-briefing-pack"],
    queryFn: () => api.getLatestPack("briefing"),
    retry: false
  });

  async function handleCopy() {
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(pack.content);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const notFound = error instanceof ApiError && error.problem.status === 404;

  return (
    <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-slate-400">☀ DAILY BRIEFING{pack ? ` (${pack.ref_date})` : ""}</h2>
        <div className="flex items-center gap-2">
          {pack && (
            <button
              onClick={handleCopy}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
            >
              {copyState === "copied" ? "✓ コピーしました" : "📋 Copy for AI"}
            </button>
          )}
          {pack && (
            <button onClick={() => setExpanded((v) => !v)} className="text-xs text-slate-500 hover:text-slate-300">
              {expanded ? "折りたたむ" : "全文を読む"}
            </button>
          )}
        </div>
      </div>
      {isLoading && <p className="text-xs text-slate-500">読み込み中…</p>}
      {notFound && <p className="text-xs text-slate-500">まだ生成されていません (research-daily 実行後に表示されます)。</p>}
      {error && !notFound && <p className="text-xs text-reject">ブリーフィングの読み込みに失敗しました。</p>}
      {pack && (
        <pre
          className={`whitespace-pre-wrap font-sans text-xs text-slate-300 ${expanded ? "" : "max-h-24 overflow-hidden"}`}
        >
          {pack.content}
        </pre>
      )}
    </section>
  );
}

const ACTION_KIND_LABEL: Record<ActionItem["kind"], string> = {
  approval: "承認",
  review: "レビュー",
  dq: "DQ"
};

const ACTION_KIND_BADGE_CLASS: Record<ActionItem["kind"], string> = {
  approval: "bg-adopt text-slate-950",
  review: "bg-watch text-slate-950",
  dq: "bg-reject text-slate-950"
};

// Action Queue (docs/06 §1 item 1 "ゼロインボックス型", docs/15 SONNET-7 V1
// slice). docs/06 §3 SCR-01's wireframe shows [承認][却下] buttons directly
// inside the queue item -- previously every item was just a link to the
// Edge Dossier, forcing a click-through + a second navigation back even
// for the one action kind ("approval": ADOPT verdict, still in TESTING)
// that has a single deterministic action (2026-07 UX audit). "review"
// items (SCREEN_DONE, or FULL_DONE without ADOPT) have no single correct
// action -- same in the wireframe, which only shows a summary line for
// those -- so they stay click-through only.
function ActionQueuePanel() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["action-queue"],
    queryFn: api.actionQueue,
    refetchInterval: 60_000
  });

  const transition = useMutation({
    mutationFn: ({ edgeId, toStatus }: { edgeId: string; toStatus: string }) =>
      api.transitionEdge(edgeId, toStatus, "Action Queueから直接操作"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["action-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["edges"] });
    }
  });

  const resolveIssue = useMutation({
    mutationFn: (issueId: number) => api.resolveDqIssue(issueId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["action-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["data-health"] });
    }
  });

  if (isLoading) return null;
  const items = data?.items ?? [];

  return (
    <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3">
      <h2 className="text-xs font-medium text-slate-400">▶ ACTION QUEUE ({items.length})</h2>
      {items.length === 0 && <p className="text-xs text-slate-600">対応待ちの項目はありません。</p>}
      <ul className="space-y-1.5">
        {items.map((item, i) => {
          const label = (
            <>
              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${ACTION_KIND_BADGE_CLASS[item.kind]}`}>
                {ACTION_KIND_LABEL[item.kind]}
              </span>{" "}
              <span className="text-sm">{item.title}</span>
              <div className="text-xs text-slate-500">{item.detail}</div>
            </>
          );
          const edgeId = item.edge_id;
          const issueId = item.issue_id;
          const transitionPending = (toStatus: string) =>
            transition.isPending && transition.variables?.edgeId === edgeId && transition.variables.toStatus === toStatus;
          return (
            <li
              key={`${item.kind}-${edgeId ?? issueId ?? item.title}-${i}`}
              className="space-y-1.5 rounded border border-slate-800 bg-slate-950 p-2"
            >
              {edgeId ? (
                <Link to="/edges/$edgeId" params={{ edgeId }} className="block hover:opacity-80">
                  {label}
                </Link>
              ) : (
                <div>{label}</div>
              )}
              {item.kind === "approval" && edgeId && (
                <div className="flex gap-2">
                  <button
                    onClick={() => transition.mutate({ edgeId, toStatus: "VALIDATED" })}
                    disabled={transition.isPending}
                    className="rounded bg-adopt px-2 py-1 text-xs font-medium text-slate-950 disabled:opacity-50"
                  >
                    {transitionPending("VALIDATED") ? "承認中…" : "承認"}
                  </button>
                  <button
                    onClick={() => transition.mutate({ edgeId, toStatus: "REJECTED" })}
                    disabled={transition.isPending}
                    className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-slate-100 disabled:opacity-50"
                  >
                    {transitionPending("REJECTED") ? "却下中…" : "却下"}
                  </button>
                </div>
              )}
              {item.kind === "dq" && issueId !== null && (
                <button
                  onClick={() => resolveIssue.mutate(issueId)}
                  disabled={resolveIssue.isPending && resolveIssue.variables === issueId}
                  className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-slate-100 disabled:opacity-50"
                >
                  {resolveIssue.isPending && resolveIssue.variables === issueId ? "解決中…" : "解決"}
                </button>
              )}
              {transition.isError && transition.variables?.edgeId === edgeId && (
                <p className="text-xs text-reject">
                  {transition.error instanceof Error ? transition.error.message : "遷移に失敗しました"}
                </p>
              )}
              {resolveIssue.isError && resolveIssue.variables === issueId && (
                <p className="text-xs text-reject">
                  {resolveIssue.error instanceof Error ? resolveIssue.error.message : "解決に失敗しました"}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
      <BriefingPanel />
      <ActionQueuePanel />
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
