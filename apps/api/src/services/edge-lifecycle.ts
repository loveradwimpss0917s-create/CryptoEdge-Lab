// Gathers the guard context canTransition() (packages/schema) needs from
// D1, then applies it. This is the only place that should call D1 for
// lifecycle decisions — routes/edges.ts must go through here rather than
// re-deriving guard inputs inline (docs/05 §2 is the single source of
// truth for the rules; this file is the single source of truth for how
// their inputs are computed).

import { canTransition, type EdgeStatus, type GuardContext } from "@cryptoedge/schema";
import type { Env } from "../env.js";

interface EdgeRow {
  edge_id: string;
  status: EdgeStatus;
  hypothesis: string;
  rationale: string;
  counter_evidence: string | null;
}

async function hasAnyVersion(env: Env, edgeId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM edge_versions WHERE edge_id = ?1 LIMIT 1`)
    .bind(edgeId)
    .first();
  return row !== null;
}

async function latestScreenRun(
  env: Env,
  edgeId: string
): Promise<{ evBps: number; pPerm: number } | null> {
  const run = await env.DB.prepare(
    `SELECT r.run_id FROM eval_runs r
     JOIN edge_versions v ON v.version_id = r.edge_version_id
     WHERE v.edge_id = ?1 AND r.run_kind = 'screen' AND r.status = 'done'
     ORDER BY r.finished_at DESC LIMIT 1`
  )
    .bind(edgeId)
    .first<{ run_id: string }>();
  if (!run) return null;

  // `ev_bps` lives under segment "overall" (the plain full-period figure),
  // but `p_perm` only ever gets written under segment "wf:oos" --
  // research/.../eval/pipeline.py's run_eep() computes exactly one
  // permutation test, always tagged wf:oos, never "overall" (2026-07
  // audit: this query used to filter segment='overall' for both metrics,
  // so `p_perm` never matched any row and this function returned null
  // unconditionally -- meaning CANDIDATE->TESTING could never pass
  // regardless of an edge's actual screen results; found live, zero of
  // the 7 CANDIDATE edges had ever recorded a transition attempt past
  // IDEA->CANDIDATE despite several already clearing both real gates).
  const metrics = await env.DB.prepare(
    `SELECT metric, value FROM eval_metrics
     WHERE run_id = ?1
       AND ((segment = 'overall' AND metric = 'ev_bps') OR (segment = 'wf:oos' AND metric = 'p_perm'))`
  )
    .bind(run.run_id)
    .all<{ metric: string; value: number }>();
  const byMetric = new Map((metrics.results ?? []).map((m) => [m.metric, m.value]));
  const evBps = byMetric.get("ev_bps");
  const pPerm = byMetric.get("p_perm");
  if (evBps === undefined || pPerm === undefined) return null;
  return { evBps, pPerm };
}

async function latestFullRunVerdict(
  env: Env,
  edgeId: string
): Promise<"ADOPT" | "WATCH" | "REJECT" | null> {
  const row = await env.DB.prepare(
    `SELECT vd.verdict FROM verdicts vd
     JOIN eval_runs r ON r.run_id = vd.run_id
     JOIN edge_versions v ON v.version_id = r.edge_version_id
     WHERE v.edge_id = ?1 AND r.run_kind = 'full'
     ORDER BY vd.decided_at DESC LIMIT 1`
  )
    .bind(edgeId)
    .first<{ verdict: "ADOPT" | "WATCH" | "REJECT" }>();
  return row?.verdict ?? null;
}

async function paperPerformance(env: Env, edgeId: string): Promise<GuardContext["PAPER_to_ACTIVE"] | null> {
  const version = await env.DB.prepare(
    `SELECT version_id, cost_model FROM edge_versions WHERE edge_id = ?1 AND is_current = 1`
  )
    .bind(edgeId)
    .first<{ version_id: string; cost_model: string }>();
  if (!version) return null;

  const signals = await env.DB.prepare(
    `SELECT ts_signal, ret_bps, ret_net_bps FROM paper_signals
     WHERE edge_version_id = ?1 AND status = 'closed' ORDER BY ts_signal ASC`
  )
    .bind(version.version_id)
    .all<{ ts_signal: number; ret_bps: number | null; ret_net_bps: number | null }>();
  const closed = (signals.results ?? []).filter((s) => s.ret_net_bps !== null);
  if (closed.length === 0) return null;

  const first = closed[0]!;
  const paperDays = (Date.now() - first.ts_signal) / 86_400_000;
  const netReturns = closed.map((s) => s.ret_net_bps as number);
  const mean = netReturns.reduce((a, b) => a + b, 0) / netReturns.length;
  const variance =
    netReturns.length > 1
      ? netReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (netReturns.length - 1)
      : 0;
  const sd = Math.sqrt(variance);
  // Simplified, non-annualized Sharpe over the paper sample — a coarse
  // proxy adequate for the PAPER -> ACTIVE gate, not a research-grade
  // metric (that comes from the OOS eval_metrics CI compared against here).
  const paperSharpe = sd > 0 ? mean / sd : 0;

  const costDrag = closed
    .filter((s) => s.ret_bps !== null)
    .map((s) => (s.ret_bps as number) - (s.ret_net_bps as number));
  const avgSlippageBps = costDrag.length > 0 ? costDrag.reduce((a, b) => a + b, 0) / costDrag.length : 0;

  const costModel = JSON.parse(version.cost_model) as { taker_bps: number; slippage_bps: number };
  const expectedCostBps = (costModel.taker_bps + costModel.slippage_bps) * 2;

  const oosSharpe = await env.DB.prepare(
    `SELECT em.ci_lo, em.ci_hi FROM eval_metrics em
     JOIN eval_runs r ON r.run_id = em.run_id
     WHERE r.edge_version_id = ?1 AND r.run_kind = 'full' AND em.segment = 'wf:oos' AND em.metric = 'sharpe'
     ORDER BY r.finished_at DESC LIMIT 1`
  )
    .bind(version.version_id)
    .first<{ ci_lo: number | null; ci_hi: number | null }>();
  if (!oosSharpe || oosSharpe.ci_lo === null || oosSharpe.ci_hi === null) return null;

  return {
    paperDays,
    signalCount: closed.length,
    paperSharpe,
    oosSharpeCi95Lo: oosSharpe.ci_lo,
    oosSharpeCi95Hi: oosSharpe.ci_hi,
    avgSlippageBps,
    expectedCostBps
  };
}

export interface TransitionOutcome {
  ok: boolean;
  reason: string;
}

export async function attemptTransition(
  env: Env,
  edge: EdgeRow,
  toStatus: EdgeStatus,
  actor: string,
  userReason: string
): Promise<TransitionOutcome> {
  const ctx: GuardContext = {};

  if (edge.status === "IDEA" && toStatus === "CANDIDATE") {
    ctx.IDEA_to_CANDIDATE = {
      hypothesis: edge.hypothesis,
      rationale: edge.rationale,
      counterEvidence: edge.counter_evidence,
      hasVersion: await hasAnyVersion(env, edge.edge_id)
    };
  } else if (edge.status === "CANDIDATE" && toStatus === "TESTING") {
    const screen = await latestScreenRun(env, edge.edge_id);
    ctx.CANDIDATE_to_TESTING = { screenRunEvBps: screen?.evBps ?? -Infinity, screenRunPPerm: screen?.pPerm ?? 1 };
  } else if (edge.status === "TESTING" && toStatus === "VALIDATED") {
    const verdict = await latestFullRunVerdict(env, edge.edge_id);
    ctx.TESTING_to_VALIDATED = { fullRunVerdict: verdict ?? "WATCH" };
  } else if (edge.status === "PAPER" && toStatus === "ACTIVE") {
    const perf = await paperPerformance(env, edge.edge_id);
    if (perf) ctx.PAPER_to_ACTIVE = perf;
  } else if (toStatus === "REJECTED") {
    const verdict = await latestFullRunVerdict(env, edge.edge_id);
    ctx.any_to_REJECTED = { fullRunVerdict: verdict ?? undefined, userInitiated: true };
  } else if (edge.status === "ACTIVE" && toStatus === "DECAYING") {
    // TODO(Phase 2, docs/05 §7): CUSUM decay detection runs in
    // research-worker and has no wired write path into the API yet. Until
    // an `/internal/decay-alerts` endpoint exists, this guard is
    // intentionally conservative (always fails) rather than trusting an
    // unauthenticated client-supplied flag.
    ctx.ACTIVE_to_DECAYING = { cusumAlarm: false };
  }

  const result = canTransition(edge.status, toStatus, ctx);
  if (!result.ok) return result;

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE edges SET status = ?1, updated_at = ?2 WHERE edge_id = ?3`).bind(
      toStatus,
      now,
      edge.edge_id
    ),
    env.DB.prepare(
      `INSERT INTO edge_transitions (edge_id, from_status, to_status, at, actor, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(edge.edge_id, edge.status, toStatus, now, actor, `${result.reason}; ${userReason}`)
  ]);

  return result;
}
