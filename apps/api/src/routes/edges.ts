// Edge resource routes (docs/08 "Edges / Versions / Runs").

import { Hono } from "hono";
import { newId } from "@cryptoedge/shared";
import {
  createEdgeRequestSchema,
  createEdgeVersionRequestSchema,
  listEdgesQuerySchema,
  transitionEdgeRequestSchema,
  type EdgeStatus
} from "@cryptoedge/schema";
import type { Env } from "../env.js";
import type { AccessVariables } from "../middleware/require-access.js";
import { audit } from "../services/audit.js";
import { attemptTransition } from "../services/edge-lifecycle.js";

export const edgesRoute = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

edgesRoute.get("/", async (c) => {
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
  const sql = `SELECT edge_id, slug, title, category, status, origin, pdf_ref, created_at, updated_at
               FROM edges ${where} ORDER BY updated_at DESC LIMIT ?${params.length + 1}`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params, query.limit)
    .all();
  return c.json({ edges: results ?? [] });
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
  const edge = await c.env.DB.prepare(`SELECT * FROM edges WHERE edge_id = ?1`).bind(edgeId).first();
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

  return c.json({ edge, current_version: version ?? null, latest_verdict: latestVerdict ?? null, runs });
});

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
