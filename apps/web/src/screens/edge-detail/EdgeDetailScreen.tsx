// SCR-03 Edge Dossier (docs/06 §3). V1 slice: Thesis + 評価履歴
// (run/verdict/wf:oos指標) + Paper タブ最小版 (paper_signals一覧, docs/15
// SONNET-5) + 新バージョンを作るフォーム (docs/15 Priority 1) — 差分diff表示や
// Related タブはまだ実装せず。評価履歴は 2026-07 レビュー Task 8 で追加。

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { createEdgeVersionRequestSchema, EDGE_DIRECTIONS, EDGE_TRANSITION_GRAPH, type EdgeStatus } from "@cryptoedge/schema";
import { api, type PaperSignal, type RunSummary, type Readiness } from "../../api/client";
import { formatUtcTimestamp } from "../../lib/format";
import {
  missingElementsSummary,
  nextActionLabel,
  READINESS_STATE_BADGE_CLASS,
  READINESS_STATE_LABEL,
  STATUS_LABEL,
  VERDICT_CHECK_LABEL,
  VERDICT_LABEL
} from "../../lib/labels";

// docs/06 §7: readiness の状態・不足要素・次アクションを1つだけ表示する。
// `runs`: FULL_DONE の案内文を実際の verdict に応じて出し分けるため
// (2026-07 ユーザー報告: verdict=REJECT でも常に「VALIDATEDを判断」と
// 表示され、対応するボタンが無いように見えて混乱した -- labels.ts
// nextActionLabel 参照)。
function ReadinessPanel({ readiness, runs }: { readiness: Readiness; runs: RunSummary[] }) {
  const chips = missingElementsSummary(readiness.missing);
  const latestFullVerdict = runs.find((r) => r.run_kind === "full" && r.verdict)?.verdict?.verdict ?? null;
  return (
    <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-slate-400">Research Readiness</h2>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${READINESS_STATE_BADGE_CLASS[readiness.state]}`}>
          {READINESS_STATE_LABEL[readiness.state]}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span key={chip} className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">
              {chip}
            </span>
          ))}
        </div>
      )}
      <p className="text-sm text-slate-300">次のアクション: {nextActionLabel(readiness, latestFullVerdict)}</p>
    </section>
  );
}

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

const PAPER_SIGNAL_STATUS_LABEL: Record<PaperSignal["status"], string> = {
  open: "オープン中",
  closed: "決済済み",
  expired: "期限切れ",
  invalidated: "無効化"
};

// Paper タブ最小版 (docs/06 SCR-03, docs/15 SONNET-5): paper_signals writer
// (workers/ingest/src/signals/paper-trading.ts) が記録した発火・決済履歴。
function PaperSignalEntry({ signal }: { signal: PaperSignal }) {
  return (
    <div className="space-y-1 border-t border-slate-800 pt-3 text-xs first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-slate-800 px-2 py-0.5 font-medium text-slate-300">
          {PAPER_SIGNAL_STATUS_LABEL[signal.status]}
        </span>
        <span className="text-slate-500">{signal.direction}</span>
        <span className="text-slate-600">{formatUtcTimestamp(signal.ts_signal)}</span>
      </div>
      {signal.ret_net_bps !== null && (
        <div className={signal.ret_net_bps >= 0 ? "text-adopt" : "text-reject"}>
          net {signal.ret_net_bps.toFixed(1)}bps (gross {signal.ret_bps?.toFixed(1) ?? "—"}bps)
        </div>
      )}
    </div>
  );
}

// 新バージョンを作る (docs/06 SCR-03 ワイヤーフレーム, docs/15 Priority 1):
// edge_version 作成の唯一の正規経路。Edge Pack v1 Phase 1 の5件はD1直接投入
// (ユーザー承認の一時対応)で入れたため、Phase 2以降の恒久フローとしてはこの
// フォームが無いと signal_spec を投入する手段が存在しなかった。
const DEFAULT_COST_MODEL = JSON.stringify({ taker_bps: 4, slippage_bps: 2, funding_included: false }, null, 2);

function CreateVersionForm({ edgeId, onCreated }: { edgeId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [semver, setSemver] = useState("1.0.0");
  const [instrumentId, setInstrumentId] = useState("BTCUSDT.BINANCE.PERP");
  const [direction, setDirection] = useState<string>("long");
  const [horizon, setHorizon] = useState("24h");
  const [signalSpecText, setSignalSpecText] = useState(
    JSON.stringify(
      { when: { cmp: [{ feature: "ret_24h" }, ">", 5] }, entry: { delay_bars: 1, price: "open" }, exit: { horizon: "24h" }, direction: "long" },
      null,
      2
    )
  );
  const [paramsText, setParamsText] = useState("{}");
  const [costModelText, setCostModelText] = useState(DEFAULT_COST_MODEL);
  const [changelog, setChangelog] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  const createVersion = useMutation({
    mutationFn: (body: Parameters<typeof api.createVersion>[1]) => api.createVersion(edgeId, body),
    onSuccess: () => {
      setOpen(false);
      onCreated();
    }
  });

  function handleSubmit() {
    setErrors([]);
    let signalSpec: unknown;
    let params: unknown;
    let costModel: unknown;
    try {
      signalSpec = JSON.parse(signalSpecText);
    } catch {
      setErrors(["signal_spec: JSONとして解析できません"]);
      return;
    }
    try {
      params = JSON.parse(paramsText);
    } catch {
      setErrors(["params: JSONとして解析できません"]);
      return;
    }
    try {
      costModel = JSON.parse(costModelText);
    } catch {
      setErrors(["cost_model: JSONとして解析できません"]);
      return;
    }

    const candidate = {
      semver,
      signal_spec: signalSpec,
      params,
      instrument_id: instrumentId,
      direction,
      horizon,
      cost_model: costModel,
      ...(changelog.trim() ? { changelog: changelog.trim() } : {})
    };
    const result = createEdgeVersionRequestSchema.safeParse(candidate);
    if (!result.success) {
      setErrors(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
      return;
    }
    createVersion.mutate(result.data);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
      >
        ＋ 新バージョンを作る
      </button>
    );
  }

  return (
    <section className="space-y-3 rounded border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-400">新バージョンを作る</h2>
        <button onClick={() => setOpen(false)} className="text-xs text-slate-500 hover:text-slate-300">
          閉じる
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="space-y-1 text-xs text-slate-500">
          semver
          <input
            value={semver}
            onChange={(e) => setSemver(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-sm text-slate-200"
          />
        </label>
        <label className="space-y-1 text-xs text-slate-500">
          instrument_id
          <input
            value={instrumentId}
            onChange={(e) => setInstrumentId(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-sm text-slate-200"
          />
        </label>
        <label className="space-y-1 text-xs text-slate-500">
          direction
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-sm text-slate-200"
          >
            {EDGE_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-500">
          horizon
          <input
            value={horizon}
            onChange={(e) => setHorizon(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-sm text-slate-200"
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-slate-500">
        signal_spec (JSON)
        <textarea
          value={signalSpecText}
          onChange={(e) => setSignalSpecText(e.target.value)}
          rows={8}
          className="w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-300"
        />
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block space-y-1 text-xs text-slate-500">
          params (JSON)
          <textarea
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            rows={3}
            className="w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-300"
          />
        </label>
        <label className="block space-y-1 text-xs text-slate-500">
          cost_model (JSON)
          <textarea
            value={costModelText}
            onChange={(e) => setCostModelText(e.target.value)}
            rows={3}
            className="w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-300"
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-slate-500">
        changelog (任意)
        <input
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-sm text-slate-200"
        />
      </label>
      {errors.length > 0 && (
        <ul className="space-y-0.5 text-xs text-reject">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {createVersion.isError && (
        <p className="text-xs text-reject">
          {createVersion.error instanceof Error ? createVersion.error.message : "バージョン作成に失敗しました"}
        </p>
      )}
      <button
        onClick={handleSubmit}
        disabled={createVersion.isPending}
        className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50"
      >
        検証してバージョン作成
      </button>
    </section>
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

      {edge.readiness && <ReadinessPanel readiness={edge.readiness} runs={data.runs} />}

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

      <CreateVersionForm edgeId={edgeId} onCreated={() => queryClient.invalidateQueries({ queryKey: ["edge", edgeId] })} />

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

      {data.paper_signals.length > 0 && (
        <section className="space-y-3 rounded border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-medium text-slate-400">Paper (直近{data.paper_signals.length}件)</h2>
          {data.paper_signals.map((signal) => (
            <PaperSignalEntry key={signal.signal_id} signal={signal} />
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
