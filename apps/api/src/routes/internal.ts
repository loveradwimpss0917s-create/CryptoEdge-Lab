// `/internal/*` — research-worker's (GitHub Actions) write path into D1
// (docs/08 "Internal", docs/01 §5: research-worker never touches D1
// directly, only through here, so schema validation/audit stay centralized).

import { Hono } from "hono";
import { newId } from "@cryptoedge/shared";
import {
  jobStatusUpdateSchema,
  READINESS_STATES,
  startRunRequestSchema,
  submitAiOutputRequestSchema,
  submitCorrelationsRequestSchema,
  submitDerivMetricsRequestSchema,
  submitEventsRequestSchema,
  submitFeatureDefsRequestSchema,
  submitFindingsRequestSchema,
  submitFundingRatesRequestSchema,
  submitLiquidationsRequestSchema,
  submitMetricsRequestSchema,
  submitRegimesRequestSchema,
  submitVerdictRequestSchema
} from "@cryptoedge/schema";
import type { Env } from "../env.js";
import { audit } from "../services/audit.js";
import { computeReadinessForEdges, type EdgeReadinessInputRow } from "../services/readiness.js";

export const internalRoute = new Hono<{ Bindings: Env }>();

// Tables backed up weekly (docs/12 §3, 2026-07 review Task 7). Whitelisted
// explicitly rather than read from sqlite_master: the table name is
// interpolated directly into SQL below since D1 can't bind an identifier,
// so this list is also the injection guard.
const BACKUP_TABLES = [
  "instruments",
  "data_sources",
  "ingest_state",
  "dq_issues",
  "ingest_tasks",
  "latest_snapshots",
  "quota_usage",
  "jobs",
  "audit_log",
  "settings",
  "candles",
  "funding_rates",
  "open_interest",
  "long_short_ratios",
  "liquidations_5m",
  "orderbook_snaps",
  "options_surface",
  "metric_defs",
  "metrics",
  "events",
  "edges",
  "edge_versions",
  "edge_transitions",
  "eval_runs",
  "eval_metrics",
  "verdicts",
  "edge_correlations",
  "regimes_daily",
  "feature_defs",
  "discovery_findings",
  "paper_signals",
  "ai_outputs"
] as const;

internalRoute.get("/backup/tables", (c) => c.json({ tables: BACKUP_TABLES }));

// Keyset pagination on `rowid` rather than OFFSET: stable and cheap even
// as tables grow, and immune to the "row shifted while paging" skew OFFSET
// has if a write lands mid-dump.
internalRoute.get("/backup/dump", async (c) => {
  const table = c.req.query("table") ?? "";
  if (!(BACKUP_TABLES as readonly string[]).includes(table)) {
    return c.json({ type: "about:blank", title: `unknown backup table: ${table}`, status: 400 }, 400);
  }
  const afterRowid = Number(c.req.query("after_rowid") ?? "0");
  const limit = Math.min(Number(c.req.query("limit") ?? "2000"), 5000);
  const { results } = await c.env.DB.prepare(
    `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid ASC LIMIT ?2`
  )
    .bind(afterRowid, limit)
    .all();
  return c.json({ rows: results ?? [] });
});

// research-worker needs the signal_spec/params/cost_model to actually run
// the EEP (docs/05 §3) — the write-only routes below don't give it a way
// to read that back, so this is the one read route on /internal.
internalRoute.get("/edge-versions/:id", async (c) => {
  const versionId = c.req.param("id");
  const version = await c.env.DB.prepare(`SELECT * FROM edge_versions WHERE version_id = ?1`)
    .bind(versionId)
    .first();
  if (!version) return c.json({ type: "about:blank", title: "edge_version not found", status: 404 }, 404);
  return c.json({ edge_version: version });
});

// The DSL's "event" node (docs/05 §9) needs real events data to evaluate
// against; research-worker fetches the window it's backtesting over here
// and buckets it per-bar itself (2026-07 review, Task 5 — previously
// on_demand.py always passed an empty events series, silently making every
// event-referencing signal_spec never fire instead of evaluating for real).
internalRoute.get("/events", async (c) => {
  const from = Number(c.req.query("from"));
  const to = Number(c.req.query("to"));
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return c.json({ type: "about:blank", title: "from/to query params (unix ms) are required", status: 400 }, 400);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT event_type, ts, magnitude FROM events WHERE ts >= ?1 AND ts < ?2 ORDER BY ts ASC`
  )
    .bind(from, to)
    .all();
  return c.json({ events: results ?? [] });
});

// Historical event backfill (docs/17 ADR-1, docs/19 S-03): shares the exact
// dedupe_key convention the live ingest adapters use (`upsertEvent` in
// workers/ingest/src/db.ts), so a backfilled row and a later live-collected
// row for the same real-world event collide on ON CONFLICT DO NOTHING
// instead of duplicating.
internalRoute.post("/events", async (c) => {
  const body = submitEventsRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO events (event_id, event_type, ts, announced_at, magnitude, payload, source_id, dedupe_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (dedupe_key) DO NOTHING`
  );
  const results = await c.env.DB.batch(
    body.events.map((e) =>
      stmt.bind(
        newId(),
        e.event_type,
        e.ts,
        e.announced_at ?? null,
        e.magnitude ?? null,
        e.payload ? JSON.stringify(e.payload) : null,
        e.source_id,
        e.dedupe_key
      )
    )
  );
  const written = results.filter((r) => (r.meta.changes ?? 0) > 0).length;
  return c.json({ written, skipped: body.events.length - written }, 201);
});

// Daily regime labels (docs/04 §6) need to be forward-filled onto the bar
// series before running the EEP — the DSL's `regime` node (docs/05 §9)
// otherwise has nothing to evaluate against. Date-string range rather than
// unix ms (like /events) since regimes_daily.dt is itself a "YYYY-MM-DD"
// TEXT primary key (2026-07 review, TASK-1: on_demand.py never fetched
// regimes_daily at all, so every regime-referencing signal_spec evaluated
// against an all-None series and could never fire).
internalRoute.get("/regimes", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json(
      { type: "about:blank", title: "from/to query params (YYYY-MM-DD, inclusive) are required", status: 400 },
      400
    );
  }
  const { results } = await c.env.DB.prepare(
    `SELECT dt, trend, vol, liquidity FROM regimes_daily WHERE dt >= ?1 AND dt <= ?2 ORDER BY dt ASC`
  )
    .bind(from, to)
    .all();
  return c.json({ regimes: results ?? [] });
});

// Research Pack data sources (docs/07 §2 DATA section, docs/15 SONNET-2):
// research-worker's daily_briefing generator reads these three so the pack
// reflects real state rather than fabricated placeholders. Kept as plain
// reads (no pagination) since they're bounded by "since yesterday" / "all
// edges", both small in V1.
internalRoute.get("/dq-issues", async (c) => {
  const since = Number(c.req.query("since") ?? "0");
  const { results } = await c.env.DB.prepare(
    `SELECT stream_id, rule_id, severity, detected_at, detail FROM dq_issues
     WHERE status = 'open' AND detected_at >= ?1 ORDER BY detected_at DESC LIMIT 50`
  )
    .bind(since)
    .all();
  return c.json({ dq_issues: results ?? [] });
});

internalRoute.get("/verdicts", async (c) => {
  const since = Number(c.req.query("since") ?? "0");
  const { results } = await c.env.DB.prepare(
    `SELECT v.verdict, v.decided_at, r.run_kind, e.title AS edge_title
     FROM verdicts v
     JOIN eval_runs r ON r.run_id = v.run_id
     JOIN edge_versions ev ON ev.version_id = r.edge_version_id
     JOIN edges e ON e.edge_id = ev.edge_id
     WHERE v.decided_at >= ?1 ORDER BY v.decided_at DESC LIMIT 50`
  )
    .bind(since)
    .all();
  return c.json({ verdicts: results ?? [] });
});

// Mirrors edges.ts's GET /readiness-summary (docs/06 §7.6) under Bearer
// auth so research-worker can embed "今すぐ評価可能: N件" in the daily
// briefing without needing Cloudflare Access credentials.
internalRoute.get("/readiness-summary", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT edge_id, status, readiness_class, readiness_blockers FROM edges`
  ).all<EdgeReadinessInputRow>();
  const readinessByEdge = await computeReadinessForEdges(c.env, results ?? []);
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

// docs/05 §3.7 DSR needs "cumulative screen+full run count against the
// edge" as n_trials; research-worker can't compute that itself (it never
// touches D1 directly), so it fetches this before running the EEP when the
// dispatch payload didn't pin an explicit n_trials (2026-07 review, Task 5).
internalRoute.get("/edges/:id/trial-count", async (c) => {
  const edgeId = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM eval_runs r
     JOIN edge_versions v ON v.version_id = r.edge_version_id
     WHERE v.edge_id = ?1 AND r.run_kind IN ('screen', 'full')`
  )
    .bind(edgeId)
    .first<{ n: number }>();
  return c.json({ edge_id: edgeId, trial_count: row?.n ?? 0 });
});

// A GitHub Actions run that claims a job and then dies (timeout, runner
// OOM, workflow cancelled) leaves it stuck in 'dispatched' forever — this
// project's jobs finish in minutes, so anything still dispatched after an
// hour is abandoned, not merely slow. Requeuing happens as part of the
// claim path (below) so it's self-healing without a separate cron
// (2026-07 review, Task 7).
const STUCK_DISPATCHED_MS = 60 * 60 * 1000;

internalRoute.get("/jobs", async (c) => {
  const status = c.req.query("status") ?? "queued";
  const limit = Number(c.req.query("limit") ?? "5");
  if (status === "queued") {
    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE jobs SET status = 'queued', started_at = NULL
       WHERE status = 'dispatched' AND started_at IS NOT NULL AND started_at < ?1`
    )
      .bind(now - STUCK_DISPATCHED_MS)
      .run();

    // Atomic claim: move up to `limit` queued jobs to 'dispatched' in one
    // statement, recording the dispatch time (via COALESCE so a later
    // explicit status update never overwrites it) so a future claim can
    // tell whether this job has gone stale.
    const { results } = await c.env.DB.prepare(
      `UPDATE jobs SET status = 'dispatched', started_at = COALESCE(started_at, ?2)
       WHERE job_id IN (
         SELECT job_id FROM jobs WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT ?1
       )
       RETURNING *`
    )
      .bind(limit, now)
      .all();
    return c.json({ jobs: results ?? [] });
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM jobs WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(status, limit)
    .all();
  return c.json({ jobs: results ?? [] });
});

internalRoute.post("/jobs/:id/status", async (c) => {
  const jobId = c.req.param("id");
  const body = jobStatusUpdateSchema.parse(await c.req.json());
  const finishedAt = body.status === "done" || body.status === "failed" ? Date.now() : null;
  await c.env.DB.prepare(
    `UPDATE jobs SET status = ?1, error = ?2, result_ref = ?3, started_at = COALESCE(started_at, ?4), finished_at = ?5 WHERE job_id = ?6`
  )
    .bind(body.status, body.error ?? null, body.result_ref ?? null, Date.now(), finishedAt, jobId)
    .run();
  return c.json({ job_id: jobId, status: body.status });
});

internalRoute.post("/runs", async (c) => {
  const body = startRunRequestSchema.parse(await c.req.json());
  const runId = newId();
  await c.env.DB.prepare(
    `INSERT INTO eval_runs
       (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, started_at, requested_by, git_sha)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', ?9, ?10, ?11)`
  )
    .bind(
      runId,
      body.edge_version_id,
      body.protocol_version,
      body.run_kind,
      body.dataset_hash,
      body.snapshot_id,
      body.seed,
      JSON.stringify(body.config),
      Date.now(),
      body.requested_by,
      body.git_sha
    )
    .run();
  return c.json({ run_id: runId }, 201);
});

internalRoute.post("/runs/:id/metrics", async (c) => {
  const runId = c.req.param("id");
  const body = submitMetricsRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO eval_metrics (run_id, segment, metric, value, ci_lo, ci_hi, meta)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (run_id, segment, metric) DO UPDATE SET
       value = excluded.value, ci_lo = excluded.ci_lo, ci_hi = excluded.ci_hi, meta = excluded.meta`
  );
  await c.env.DB.batch(
    body.metrics.map((m) =>
      stmt.bind(
        runId,
        m.segment,
        m.metric,
        m.value,
        m.ci_lo ?? null,
        m.ci_hi ?? null,
        m.meta ? JSON.stringify(m.meta) : null
      )
    )
  );
  return c.json({ run_id: runId, written: body.metrics.length }, 201);
});

internalRoute.post("/runs/:id/verdict", async (c) => {
  const runId = c.req.param("id");
  const body = submitVerdictRequestSchema.parse(await c.req.json());
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO verdicts (run_id, verdict, score, reasons, thresholds_version, decided_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (run_id) DO UPDATE SET
         verdict = excluded.verdict, score = excluded.score, reasons = excluded.reasons,
         thresholds_version = excluded.thresholds_version, decided_at = excluded.decided_at`
    ).bind(runId, body.verdict, body.score ?? null, JSON.stringify(body.reasons), body.thresholds_version, now),
    c.env.DB.prepare(`UPDATE eval_runs SET status = 'done', finished_at = ?1 WHERE run_id = ?2`).bind(now, runId)
  ]);
  await audit(c.env, "system:research-worker", "run.verdict", `run:${runId}`, { verdict: body.verdict });
  return c.json({ run_id: runId, verdict: body.verdict }, 201);
});

internalRoute.post("/findings", async (c) => {
  const body = submitFindingsRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO discovery_findings (finding_id, batch_id, kind, spec, stats, fdr_q, novelty, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'new', ?8)`
  );
  const now = Date.now();
  await c.env.DB.batch(
    body.findings.map((f) =>
      stmt.bind(f.finding_id, f.batch_id, f.kind, JSON.stringify(f.spec), JSON.stringify(f.stats), f.fdr_q, f.novelty ?? null, now)
    )
  );
  return c.json({ written: body.findings.length }, 201);
});

// Feature Store v1 ledger (docs/02 §feature_defs, docs/04 §3.1, 2026-07
// design audit TASK-2): the feature *values* live in R2 Parquet
// (jobs/features_sync.py), this just registers what exists so it's
// traceable/reproducible from spec.
internalRoute.post("/feature-defs", async (c) => {
  const body = submitFeatureDefsRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO feature_defs (feature_id, version, spec, cadence, lookback_required, family, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)
     ON CONFLICT (feature_id) DO UPDATE SET
       version = excluded.version, spec = excluded.spec, cadence = excluded.cadence,
       lookback_required = excluded.lookback_required, family = excluded.family`
  );
  const now = Date.now();
  await c.env.DB.batch(
    body.feature_defs.map((f) =>
      stmt.bind(f.feature_id, f.version, JSON.stringify(f.spec), f.cadence, f.lookback_required ?? null, f.family, now)
    )
  );
  return c.json({ written: body.feature_defs.length }, 201);
});

internalRoute.post("/regimes", async (c) => {
  const body = submitRegimesRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO regimes_daily (dt, trend, vol, liquidity, hmm_state, probs, model_version, computed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (dt) DO UPDATE SET
       trend = excluded.trend, vol = excluded.vol, liquidity = excluded.liquidity,
       hmm_state = excluded.hmm_state, probs = excluded.probs, model_version = excluded.model_version,
       computed_at = excluded.computed_at`
  );
  const now = Date.now();
  await c.env.DB.batch(
    body.regimes.map((r) =>
      stmt.bind(r.dt, r.trend, r.vol, r.liquidity, r.hmm_state ?? null, r.probs ? JSON.stringify(r.probs) : null, r.model_version, now)
    )
  );
  return c.json({ written: body.regimes.length }, 201);
});

// Historical funding-rate backfill (docs/03 §2.1/§5, 2026-07 design audit
// TASK-3): data.binance.vision's monthly fundingRate archives, not the live
// OKX-fed trickle these tables otherwise get.
internalRoute.post("/funding-rates", async (c) => {
  const body = submitFundingRatesRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO funding_rates (instrument_id, ts, rate, predicted_rate, mark_price, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (instrument_id, ts) DO UPDATE SET
       rate = excluded.rate, predicted_rate = excluded.predicted_rate, mark_price = excluded.mark_price`
  );
  const now = Date.now();
  await c.env.DB.batch(
    body.funding_rates.map((f) =>
      stmt.bind(f.instrument_id, f.ts, f.rate, f.predicted_rate ?? null, f.mark_price ?? null, now)
    )
  );
  return c.json({ written: body.funding_rates.length }, 201);
});

// Historical open-interest + long/short-ratio backfill (docs/03 §2.2,
// 2026-07 design audit TASK-3): both come from the same
// data.binance.vision "metrics" daily archive, so one endpoint upserts both
// tables per research-worker call.
internalRoute.post("/deriv-metrics", async (c) => {
  const body = submitDerivMetricsRequestSchema.parse(await c.req.json());
  const oiStmt = c.env.DB.prepare(
    `INSERT INTO open_interest (instrument_id, ts, oi_base, oi_usd, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (instrument_id, ts) DO UPDATE SET
       oi_base = excluded.oi_base, oi_usd = excluded.oi_usd`
  );
  const lsStmt = c.env.DB.prepare(
    `INSERT INTO long_short_ratios (instrument_id, ratio_type, ts, long_ratio, short_ratio, ls_ratio, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (instrument_id, ratio_type, ts) DO UPDATE SET
       long_ratio = excluded.long_ratio, short_ratio = excluded.short_ratio, ls_ratio = excluded.ls_ratio`
  );
  const now = Date.now();
  await c.env.DB.batch([
    ...body.open_interest.map((o) => oiStmt.bind(o.instrument_id, o.ts, o.oi_base, o.oi_usd ?? null, now)),
    ...body.long_short_ratios.map((r) =>
      lsStmt.bind(r.instrument_id, r.ratio_type, r.ts, r.long_ratio, r.short_ratio, r.ls_ratio ?? null, now)
    )
  ]);
  return c.json({ written: body.open_interest.length + body.long_short_ratios.length }, 201);
});

// Historical liquidation backfill (docs/03 §2.2, 2026-07 design audit
// TASK-3): data.binance.vision's daily liquidationSnapshot archives,
// aggregated into 5m buckets by research-worker before upserting.
internalRoute.post("/liquidations", async (c) => {
  const body = submitLiquidationsRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO liquidations_5m (instrument_id, ts, long_liq_usd, short_liq_usd, events, max_single_usd, source_id, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (instrument_id, ts, source_id) DO UPDATE SET
       long_liq_usd = excluded.long_liq_usd, short_liq_usd = excluded.short_liq_usd,
       events = excluded.events, max_single_usd = excluded.max_single_usd`
  );
  const now = Date.now();
  await c.env.DB.batch(
    body.liquidations.map((l) =>
      stmt.bind(
        l.instrument_id,
        l.ts,
        l.long_liq_usd,
        l.short_liq_usd,
        l.events,
        l.max_single_usd ?? null,
        l.source_id,
        now
      )
    )
  );
  return c.json({ written: body.liquidations.length }, 201);
});

// Research Pack registration (docs/07 §2, docs/15 SONNET-2): research-worker
// has already generated the pack content (deterministic template) and
// written it to R2 at `content_ref`; this just records it in `ai_outputs` so
// GET /api/v1/packs/:kind/latest can find and serve it.
internalRoute.post("/ai-outputs", async (c) => {
  const body = submitAiOutputRequestSchema.parse(await c.req.json());
  const outputId = newId();
  await c.env.DB.prepare(
    `INSERT INTO ai_outputs (output_id, kind, ref_date, entity, model, prompt_version, content_ref, tokens_in, tokens_out, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10)`
  )
    .bind(
      outputId,
      body.kind,
      body.ref_date ?? null,
      body.entity ?? null,
      body.model,
      body.prompt_version,
      body.content_ref,
      body.tokens_in ?? null,
      body.tokens_out ?? null,
      Date.now()
    )
    .run();
  return c.json({ output_id: outputId }, 201);
});

internalRoute.post("/correlations", async (c) => {
  const body = submitCorrelationsRequestSchema.parse(await c.req.json());
  const stmt = c.env.DB.prepare(
    `INSERT INTO edge_correlations (edge_a, edge_b, window, signal_overlap, return_corr, computed_at, run_batch)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (edge_a, edge_b, window) DO UPDATE SET
       signal_overlap = excluded.signal_overlap, return_corr = excluded.return_corr,
       computed_at = excluded.computed_at, run_batch = excluded.run_batch`
  );
  const now = Date.now();
  await c.env.DB.batch(
    body.correlations.map((corr) => {
      const [a, b] = corr.edge_a < corr.edge_b ? [corr.edge_a, corr.edge_b] : [corr.edge_b, corr.edge_a];
      return stmt.bind(a, b, corr.window, corr.signal_overlap ?? null, corr.return_corr ?? null, now, corr.run_batch ?? null);
    })
  );
  return c.json({ written: body.correlations.length }, 201);
});
