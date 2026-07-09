// Edge resource routes (docs/08 "Edges / Versions / Runs").

import { Hono } from "hono";
import { dispatchResearchEvent, newId } from "@cryptoedge/shared";
import {
  createEdgeRequestSchema,
  createEdgeVersionRequestSchema,
  evalEdgeRequestSchema,
  listEdgesQuerySchema,
  READINESS_STATES,
  transitionEdgeRequestSchema,
  type EdgeStatus
} from "@cryptoedge/schema";
import type { Env } from "../env.js";
import type { AccessVariables } from "../middleware/require-access.js";
import { audit } from "../services/audit.js";
import { attemptTransition } from "../services/edge-lifecycle.js";
import { reapStuckEvalRuns } from "../services/eval-runs.js";
import { computeReadinessForEdges, type EdgeReadinessInputRow } from "../services/readiness.js";

// Matches workers/ingest/src/index.ts's GITHUB_REPO — both Workers dispatch
// to the same repo, just different event types.
const GITHUB_REPO = "loveradwimpss0917s-create/CryptoEdge-Lab";

export const edgesRoute = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

edgesRoute.get("/", async (c) => {
  await reapStuckEvalRuns(c.env);
  const query = listEdgesQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    conditions.push(`status = ?${params.length + 1}`);
    params.push(query.status);
  }
  if (query.category) {
    conditions.push(`category = ?${params.length + 1}`);
    params.push(query.category);
  }
  if (query.q) {
    conditions.push(`title LIKE ?${params.length + 1}`);
    params.push(`%${query.q}%`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT edge_id, slug, title, category, status, origin, pdf_ref, created_at, updated_at, readiness_class, readiness_blockers
               FROM edges ${where} ORDER BY updated_at DESC LIMIT ?${params.length + 1}`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params, query.limit)
    .all<EdgeReadinessInputRow & Record<string, unknown>>();
  const rows = results ?? [];

  // Research Readiness (docs/06 §7): computed here, not stored, so it's
  // always live against the current edge_versions/eval_runs/feature_defs/
  // data state (2026-07 design).
  const readinessByEdge = await computeReadinessForEdges(c.env, rows);
  const edges = rows.map((row) => ({ ...row, readiness: readinessByEdge.get(row.edge_id) ?? null }));

  return c.json({ edges });
});

// Today's readiness rollup (docs/06 §7.6 SCR-01): "何件が今すぐ評価できるか"
// + ブロック理由の内訳 + レビュー待ち件数。Board の Readiness ビューと同じ
// computeReadinessForEdges を使い、集計だけが違う。
edgesRoute.get("/readiness-summary", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT edge_id, status, readiness_class, readiness_blockers FROM edges`
  ).all<EdgeReadinessInputRow>();
  const rows = results ?? [];
  const readinessByEdge = await computeReadinessForEdges(c.env, rows);

  const counts = Object.fromEntries(READINESS_STATES.map((s) => [s, 0])) as Record<string, number>;
  for (const result of readinessByEdge.values()) counts[result.state] = (counts[result.state] ?? 0) + 1;

  return c.json({
    ready_count: counts.READY,
    review_pending: { screen: counts.SCREEN_DONE, full: counts.FULL_DONE },
    blocked_breakdown: {
      build_pending: counts.BUILD_PENDING,
      signal_spec_pending: counts.SIGNAL_SPEC_PENDING,
      feature_pending: counts.FEATURE_PENDING,
      data_pending: counts.DATA_PENDING
    }
  });
});

edgesRoute.post("/", async (c) => {
  const body = createEdgeRequestSchema.parse(await c.req.json());
  const edgeId = newId();
  const now = Date.now();
  const slug = body.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  await c.env.DB.prepare(
    `INSERT INTO edges
       (edge_id, slug, title, category, status, hypothesis, rationale, counter_evidence, evidence, origin, pdf_ref, priors, discovery_finding_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'IDEA', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`
  )
    .bind(
      edgeId,
      slug,
      body.title,
      body.category,
      body.hypothesis,
      body.rationale,
      body.counter_evidence ?? null,
      body.evidence ? JSON.stringify(body.evidence) : null,
      body.origin,
      body.pdf_ref ?? null,
      body.priors ? JSON.stringify(body.priors) : null,
      body.finding_id ?? null,
      now
    )
    .run();

  const actor = `user:${c.get("userEmail")}`;
  await audit(c.env, actor, "edge.create", `edge:${edgeId}`, { title: body.title });
  return c.json({ edge_id: edgeId, slug, status: "IDEA" }, 201);
});

edgesRoute.get("/:id", async (c) => {
  const edgeId = c.req.param("id");
  const edge = await c.env.DB.prepare(`SELECT * FROM edges WHERE edge_id = ?1`)
    .bind(edgeId)
    .first<EdgeReadinessInputRow & Record<string, unknown>>();
  if (!edge) return c.json({ type: "about:blank", title: "edge not found", status: 404 }, 404);

  const version = await c.env.DB.prepare(
    `SELECT * FROM edge_versions WHERE edge_id = ?1 AND is_current = 1`
  )
    .bind(edgeId)
    .first();
  const latestVerdict = version
    ? await c.env.DB.prepare(
        `SELECT vd.* FROM verdicts vd
         JOIN eval_runs r ON r.run_id = vd.run_id
         WHERE r.edge_version_id = ?1 ORDER BY vd.decided_at DESC LIMIT 1`
      )
        .bind(version["version_id"])
        .first()
    : null;

  const runs = version ? await fetchRecentRuns(c.env, version["version_id"] as string) : [];
  const paperSignals = version ? await fetchRecentPaperSignals(c.env, version["version_id"] as string) : [];
  const readinessByEdge = await computeReadinessForEdges(c.env, [edge]);

  return c.json({
    edge: { ...edge, readiness: readinessByEdge.get(edgeId) ?? null },
    current_version: version ?? null,
    latest_verdict: latestVerdict ?? null,
    runs,
    paper_signals: paperSignals
  });
});

// Paper タブ最小版 (docs/06 SCR-03, docs/15 SONNET-5):直近のpaper_signals実績。
// PAPER->ACTIVE ゲート (docs/05 §2, edge-lifecycle.ts) が読む行と同じ実データ。
interface PaperSignalRow {
  signal_id: string;
  status: string;
  direction: string;
  ts_signal: number;
  ts_entry: number | null;
  ts_exit: number | null;
  entry_px: number | null;
  exit_px: number | null;
  ret_bps: number | null;
  ret_net_bps: number | null;
}

async function fetchRecentPaperSignals(env: Env, edgeVersionId: string): Promise<PaperSignalRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT signal_id, status, direction, ts_signal, ts_entry, ts_exit, entry_px, exit_px, ret_bps, ret_net_bps
     FROM paper_signals WHERE edge_version_id = ?1 ORDER BY ts_signal DESC LIMIT 20`
  )
    .bind(edgeVersionId)
    .all<PaperSignalRow>();
  return results ?? [];
}

// 評価履歴 (2026-07 レビュー Task 8): Edge Dossier に直近の run/verdict/主要
// OOS 指標をまとめて返す。1 run あたり verdict + metrics の2クエリだが、
// 直近5件までなので D1 の読み込み予算 (5M/日, docs/13 §1) に対して無視できる。
interface RunSummaryRow {
  run_id: string;
  run_kind: string;
  status: string;
  started_at: number | null;
  finished_at: number | null;
}

async function fetchRecentRuns(env: Env, edgeVersionId: string) {
  const { results } = await env.DB.prepare(
    `SELECT run_id, run_kind, status, started_at, finished_at FROM eval_runs
     WHERE edge_version_id = ?1 ORDER BY COALESCE(finished_at, started_at, 0) DESC LIMIT 5`
  )
    .bind(edgeVersionId)
    .all<RunSummaryRow>();

  return Promise.all(
    (results ?? []).map(async (run) => {
      const [verdictRow, metricRows] = await Promise.all([
        env.DB.prepare(`SELECT verdict, reasons, decided_at FROM verdicts WHERE run_id = ?1`)
          .bind(run.run_id)
          .first<{ verdict: string; reasons: string; decided_at: number }>(),
        env.DB.prepare(
          `SELECT metric, value FROM eval_metrics
           WHERE run_id = ?1 AND segment = 'wf:oos' AND metric IN ('ev_bps', 'sharpe', 'dsr', 'p_perm')`
        )
          .bind(run.run_id)
          .all<{ metric: string; value: number }>()
      ]);
      const metricsByName = new Map((metricRows.results ?? []).map((m) => [m.metric, m.value]));

      return {
        run_id: run.run_id,
        run_kind: run.run_kind,
        status: run.status,
        started_at: run.started_at,
        finished_at: run.finished_at,
        verdict: verdictRow
          ? {
              verdict: verdictRow.verdict,
              reasons: JSON.parse(verdictRow.reasons) as unknown[],
              decided_at: verdictRow.decided_at
            }
          : null,
        metrics: {
          ev_bps: metricsByName.get("ev_bps") ?? null,
          sharpe: metricsByName.get("sharpe") ?? null,
          dsr: metricsByName.get("dsr") ?? null,
          p_perm: metricsByName.get("p_perm") ?? null
        }
      };
    })
  );
}

// Evaluation trigger (docs/08 POST /edges/{id}/eval): queues an eep job and
// pokes research-worker via repository_dispatch. Without this, screen/full
// runs never happen for a UI-driven Edge — the CANDIDATE->TESTING and
// TESTING->VALIDATED guards (docs/05 §2) would have nothing to check
// against (2026-07: closed this gap so the app is actually usable end to
// end, not just for the 5 seeded Edges research-worker happens to be
// pointed at manually).
edgesRoute.post("/:id/eval", async (c) => {
  const edgeId = c.req.param("id");
  const body = evalEdgeRequestSchema.parse(await c.req.json());

  const edge = await c.env.DB.prepare(`SELECT edge_id FROM edges WHERE edge_id = ?1`).bind(edgeId).first();
  if (!edge) return c.json({ type: "about:blank", title: "edge not found", status: 404 }, 404);

  const version = await c.env.DB.prepare(`SELECT version_id FROM edge_versions WHERE version_id = ?1 AND edge_id = ?2`)
    .bind(body.version_id, edgeId)
    .first();
  if (!version) {
    return c.json({ type: "about:blank", title: "edge_version not found for this edge", status: 404 }, 404);
  }

  const jobId = newId();
  const payload = JSON.stringify({ edge_version_id: body.version_id, kind: body.kind });
  await c.env.DB.prepare(
    `INSERT INTO jobs (job_id, kind, payload, status, priority, created_at) VALUES (?1, 'eep', ?2, 'queued', 5, ?3)`
  )
    .bind(jobId, payload, Date.now())
    .run();

  const actor = `user:${c.get("userEmail")}`;
  await audit(c.env, actor, "edge.eval_requested", `edge:${edgeId}`, {
    versionId: body.version_id,
    kind: body.kind,
    jobId
  });

  // Worker dispatch is the primary trigger (docs/01 §3.2); if GITHUB_PAT
  // isn't configured or GitHub's API hiccups, the job still sits in `jobs`
  // as 'queued' and gets picked up by the next research-on-demand run
  // (manual workflow_dispatch, or its weekly schedule safety net) — a
  // dispatch failure here must never fail the request.
  if (c.env.GITHUB_PAT) {
    await dispatchResearchEvent({ githubPat: c.env.GITHUB_PAT, repo: GITHUB_REPO }, "research-on-demand", {
      edge_version_id: body.version_id,
      kind: body.kind
    }).catch(() => undefined);
  }

  return c.json({ job_id: jobId, status: "queued" }, 202);
});

edgesRoute.post("/:id/versions", async (c) => {
  const edgeId = c.req.param("id");
  const body = createEdgeVersionRequestSchema.parse(await c.req.json());
  const versionId = newId();
  const now = Date.now();

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE edge_versions SET is_current = 0 WHERE edge_id = ?1 AND is_current = 1`).bind(
      edgeId
    ),
    c.env.DB.prepare(
      `INSERT INTO edge_versions
         (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, entry_universe, cost_model, changelog, created_at, is_current)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)`
    ).bind(
      versionId,
      edgeId,
      body.semver,
      JSON.stringify(body.signal_spec),
      JSON.stringify(body.params),
      body.instrument_id,
      body.direction,
      body.horizon,
      body.entry_universe ? JSON.stringify(body.entry_universe) : null,
      JSON.stringify(body.cost_model),
      body.changelog ?? null,
      now
    )
  ]);

  const actor = `user:${c.get("userEmail")}`;
  await audit(c.env, actor, "edge_version.create", `edge:${edgeId}`, { versionId, semver: body.semver });
  return c.json({ version_id: versionId, semver: body.semver }, 201);
});

edgesRoute.post("/:id/transitions", async (c) => {
  const edgeId = c.req.param("id");
  const body = transitionEdgeRequestSchema.parse(await c.req.json());
  const edge = await c.env.DB.prepare(
    `SELECT edge_id, status, hypothesis, rationale, counter_evidence FROM edges WHERE edge_id = ?1`
  )
    .bind(edgeId)
    .first<{
      edge_id: string;
      status: EdgeStatus;
      hypothesis: string;
      rationale: string;
      counter_evidence: string | null;
    }>();
  if (!edge) return c.json({ type: "about:blank", title: "edge not found", status: 404 }, 404);

  const actor = `user:${c.get("userEmail")}`;
  const result = await attemptTransition(c.env, edge, body.to_status, actor, body.reason);
  if (!result.ok) {
    return c.json({ type: "about:blank", title: "transition rejected", status: 409, detail: result.reason }, 409);
  }
  await audit(c.env, actor, "edge.transition", `edge:${edgeId}`, {
    from: edge.status,
    to: body.to_status,
    reason: result.reason
  });
  return c.json({ edge_id: edgeId, from_status: edge.status, to_status: body.to_status, reason: result.reason });
});
