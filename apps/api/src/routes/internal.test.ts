import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { internalRoute } from "./internal.js";
import type { Env } from "../env.js";

let fake: FakeD1;
let env: Env;

beforeEach(() => {
  fake = new FakeD1();
  env = { DB: fake as unknown as D1Database } as Env;
});

afterEach(() => {
  fake.close();
});

describe("GET /internal/edge-versions/:id", () => {
  it("returns 404 for an unknown version", async () => {
    const res = await internalRoute.request("/edge-versions/nope", {}, env);
    expect(res.status).toBe(404);
  });

  it("returns the stored edge_version row", async () => {
    await env.DB.prepare(
      `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
       VALUES ('e1', 'slug', 'Title', 'microstructure', 'CANDIDATE', 'h', 'r', 'manual', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', 'e1', '1.0.0', '{"when":{}}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
    ).run();

    const res = await internalRoute.request("/edge-versions/v1", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edge_version: { version_id: string; semver: string } };
    expect(body.edge_version.version_id).toBe("v1");
    expect(body.edge_version.semver).toBe("1.0.0");
  });
});

describe("GET /internal/events", () => {
  it("rejects missing/invalid from-to params", async () => {
    const res = await internalRoute.request("/events?from=abc&to=100", {}, env);
    expect(res.status).toBe(400);
  });

  it("returns events within [from, to) ordered by ts", async () => {
    const stmt = env.DB.prepare(
      `INSERT INTO events (event_id, event_type, ts, source_id, dedupe_key, magnitude)
       VALUES (?1, ?2, ?3, 'src', ?1, ?4)`
    );
    await stmt.bind("ev1", "cpi_release", 100, 1.5).run();
    await stmt.bind("ev2", "cpi_release", 200, 2.0).run();
    await stmt.bind("ev3", "cpi_release", 300, 3.0).run(); // outside [100,300)

    const res = await internalRoute.request("/events?from=100&to=300", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { event_type: string; ts: number; magnitude: number }[] };
    expect(body.events.map((e) => e.ts)).toEqual([100, 200]);
  });
});

describe("GET /internal/regimes (2026-07 review, TASK-1)", () => {
  it("rejects missing/invalid from-to params", async () => {
    const res = await internalRoute.request("/regimes?from=2026-07-01&to=not-a-date", {}, env);
    expect(res.status).toBe(400);
  });

  it("returns regimes within [from, to] (inclusive) ordered by dt", async () => {
    const stmt = env.DB.prepare(
      `INSERT INTO regimes_daily (dt, trend, vol, liquidity, model_version, computed_at)
       VALUES (?1, ?2, ?3, ?4, 'rule-based-1.0', 1)`
    );
    await stmt.bind("2026-06-30", "down", "low", "normal").run(); // before range
    await stmt.bind("2026-07-01", "up", "low", "normal").run();
    await stmt.bind("2026-07-02", "range", "high", "stressed").run();
    await stmt.bind("2026-07-03", "up", "low", "normal").run(); // after range

    const res = await internalRoute.request("/regimes?from=2026-07-01&to=2026-07-02", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { regimes: { dt: string; trend: string }[] };
    expect(body.regimes.map((r) => r.dt)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(body.regimes[0]!.trend).toBe("up");
  });
});

describe("POST /internal/feature-defs (2026-07 review, TASK-2)", () => {
  it("upserts feature_defs, spec as JSON, and is idempotent on re-registration", async () => {
    const res = await internalRoute.request(
      "/feature-defs",
      {
        method: "POST",
        body: JSON.stringify({
          feature_defs: [
            {
              feature_id: "v1.ret_24h",
              version: 1,
              spec: { base: "close", feature_set_version: "v1" },
              cadence: "1h",
              lookback_required: "24bars",
              family: "price"
            }
          ]
        })
      },
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { written: number };
    expect(body.written).toBe(1);

    const row = await env.DB.prepare(`SELECT spec, family, status FROM feature_defs WHERE feature_id = 'v1.ret_24h'`)
      .first<{ spec: string; family: string; status: string }>();
    expect(JSON.parse(row!.spec)).toEqual({ base: "close", feature_set_version: "v1" });
    expect(row!.family).toBe("price");
    expect(row!.status).toBe("active");

    // Re-registering (e.g. next week's sync run) must not fail on the PK.
    const res2 = await internalRoute.request(
      "/feature-defs",
      {
        method: "POST",
        body: JSON.stringify({
          feature_defs: [
            { feature_id: "v1.ret_24h", version: 2, spec: { base: "close" }, cadence: "1h", family: "price" }
          ]
        })
      },
      env
    );
    expect(res2.status).toBe(201);
    const updated = await env.DB.prepare(`SELECT version FROM feature_defs WHERE feature_id = 'v1.ret_24h'`)
      .first<{ version: number }>();
    expect(updated!.version).toBe(2);
  });
});

describe("POST /internal/funding-rates (2026-07 review, TASK-3)", () => {
  it("upserts funding_rates and is idempotent on re-submission", async () => {
    const res = await internalRoute.request(
      "/funding-rates",
      {
        method: "POST",
        body: JSON.stringify({
          funding_rates: [
            { instrument_id: "BTCUSDT.BINANCE.PERP", ts: 1000, rate: 0.0001, predicted_rate: null, mark_price: null }
          ]
        })
      },
      env
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { written: number }).written).toBe(1);

    const res2 = await internalRoute.request(
      "/funding-rates",
      {
        method: "POST",
        body: JSON.stringify({
          funding_rates: [{ instrument_id: "BTCUSDT.BINANCE.PERP", ts: 1000, rate: 0.0002 }]
        })
      },
      env
    );
    expect(res2.status).toBe(201);
    const row = await env.DB.prepare(
      `SELECT rate FROM funding_rates WHERE instrument_id = 'BTCUSDT.BINANCE.PERP' AND ts = 1000`
    ).first<{ rate: number }>();
    expect(row!.rate).toBe(0.0002);
  });
});

describe("POST /internal/deriv-metrics (2026-07 review, TASK-3)", () => {
  it("upserts both open_interest and long_short_ratios from one payload", async () => {
    const res = await internalRoute.request(
      "/deriv-metrics",
      {
        method: "POST",
        body: JSON.stringify({
          open_interest: [{ instrument_id: "BTCUSDT.BINANCE.PERP", ts: 1000, oi_base: 12345.0 }],
          long_short_ratios: [
            {
              instrument_id: "BTCUSDT.BINANCE.PERP",
              ratio_type: "all_account",
              ts: 1000,
              long_ratio: 0.6,
              short_ratio: 0.4,
              ls_ratio: 1.5
            }
          ]
        })
      },
      env
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { written: number }).written).toBe(2);

    const oi = await env.DB.prepare(`SELECT oi_base FROM open_interest WHERE ts = 1000`).first<{ oi_base: number }>();
    expect(oi!.oi_base).toBe(12345.0);
    const ls = await env.DB.prepare(`SELECT ls_ratio FROM long_short_ratios WHERE ts = 1000`).first<{
      ls_ratio: number;
    }>();
    expect(ls!.ls_ratio).toBe(1.5);
  });

  it("accepts a payload with only one of the two arrays populated", async () => {
    const res = await internalRoute.request(
      "/deriv-metrics",
      { method: "POST", body: JSON.stringify({ open_interest: [], long_short_ratios: [] }) },
      env
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { written: number }).written).toBe(0);
  });
});

describe("POST /internal/liquidations (2026-07 review, TASK-3)", () => {
  it("upserts liquidations_5m keyed by (instrument_id, ts, source_id)", async () => {
    const res = await internalRoute.request(
      "/liquidations",
      {
        method: "POST",
        body: JSON.stringify({
          liquidations: [
            {
              instrument_id: "BTCUSDT.BINANCE.PERP",
              ts: 1000,
              long_liq_usd: 5000.0,
              short_liq_usd: 0,
              events: 3,
              max_single_usd: 2000.0,
              source_id: "binance_data_vision"
            }
          ]
        })
      },
      env
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { written: number }).written).toBe(1);

    const row = await env.DB.prepare(
      `SELECT long_liq_usd, events FROM liquidations_5m WHERE ts = 1000 AND source_id = 'binance_data_vision'`
    ).first<{ long_liq_usd: number; events: number }>();
    expect(row!.long_liq_usd).toBe(5000.0);
    expect(row!.events).toBe(3);
  });
});

describe("GET /internal/edges/:id/trial-count", () => {
  it("returns 0 for an edge with no runs yet", async () => {
    const res = await internalRoute.request("/edges/e1/trial-count", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edge_id: string; trial_count: number };
    expect(body).toEqual({ edge_id: "e1", trial_count: 0 });
  });

  it("counts screen+full runs across the edge's versions, excluding other kinds", async () => {
    await env.DB.prepare(
      `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
       VALUES ('e1', 'slug', 'Title', 'microstructure', 'CANDIDATE', 'h', 'r', 'manual', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', 'e1', '1.0.0', '{"when":{}}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
    ).run();
    const runStmt = env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, requested_by, git_sha)
       VALUES (?1, 'v1', '1.0', ?2, 'h', 's', 0, '{}', 'done', 'test', 'sha')`
    );
    await runStmt.bind("r1", "screen").run();
    await runStmt.bind("r2", "full").run();
    await runStmt.bind("r3", "incremental").run();

    const res = await internalRoute.request("/edges/e1/trial-count", {}, env);
    const body = (await res.json()) as { edge_id: string; trial_count: number };
    expect(body.trial_count).toBe(2);
  });
});

describe("GET /internal/jobs?status=queued (claim + stuck requeue)", () => {
  it("claims queued jobs, oldest first, and records started_at", async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (job_id, kind, payload, status, priority, created_at) VALUES (?1, 'eep', '{}', 'queued', 5, ?2)`
    )
      .bind("j1", 100)
      .run();
    await env.DB.prepare(
      `INSERT INTO jobs (job_id, kind, payload, status, priority, created_at) VALUES (?1, 'eep', '{}', 'queued', 5, ?2)`
    )
      .bind("j2", 200)
      .run();

    const res = await internalRoute.request("/jobs?status=queued&limit=1", {}, env);
    const body = (await res.json()) as { jobs: { job_id: string; status: string; started_at: number }[] };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]!.job_id).toBe("j1");
    expect(body.jobs[0]!.status).toBe("dispatched");
    expect(body.jobs[0]!.started_at).toBeGreaterThan(0);
  });

  it("requeues a job stuck in dispatched for over an hour before claiming", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs (job_id, kind, payload, status, priority, created_at, started_at)
       VALUES (?1, 'eep', '{}', 'dispatched', 5, ?2, ?3)`
    )
      .bind("stuck", now - 120_000, now - 61 * 60 * 1000)
      .run();

    const res = await internalRoute.request("/jobs?status=queued&limit=5", {}, env);
    const body = (await res.json()) as { jobs: { job_id: string }[] };
    expect(body.jobs.map((j) => j.job_id)).toContain("stuck");
  });

  it("leaves a recently dispatched job alone", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs (job_id, kind, payload, status, priority, created_at, started_at)
       VALUES (?1, 'eep', '{}', 'dispatched', 5, ?2, ?3)`
    )
      .bind("fresh", now - 60_000, now - 5 * 60 * 1000)
      .run();

    const res = await internalRoute.request("/jobs?status=queued&limit=5", {}, env);
    const body = (await res.json()) as { jobs: { job_id: string }[] };
    expect(body.jobs.map((j) => j.job_id)).not.toContain("fresh");

    const row = await env.DB.prepare(`SELECT status FROM jobs WHERE job_id = 'fresh'`).first<{ status: string }>();
    expect(row?.status).toBe("dispatched");
  });
});

describe("POST /internal/regimes (2026-07: null vs. omitted hmm_state/probs)", () => {
  it("accepts an explicit null for hmm_state/probs, not just an omitted key", async () => {
    // Pydantic's model_dump(mode="json") always serializes an unset
    // Optional[...] field as `null`, never omits the key — a plain
    // z.number().optional() (no .nullable()) rejects that with a 400,
    // which broke the very first live regimes_daily backfill.
    const res = await internalRoute.request(
      "/regimes",
      {
        method: "POST",
        body: JSON.stringify({
          regimes: [
            {
              dt: "2026-07-01",
              trend: "up",
              vol: "low",
              liquidity: "normal",
              hmm_state: null,
              probs: null,
              model_version: "rule-based-1.0"
            }
          ]
        })
      },
      env
    );
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(`SELECT hmm_state, probs FROM regimes_daily WHERE dt = '2026-07-01'`).first<{
      hmm_state: number | null;
      probs: string | null;
    }>();
    expect(row?.hmm_state).toBeNull();
    expect(row?.probs).toBeNull();
  });
});

describe("POST /internal/runs/:id/metrics (2026-07: null vs. omitted ci_lo/ci_hi/meta)", () => {
  it("accepts an explicit null for ci_lo/ci_hi/meta, not just an omitted key", async () => {
    // Same Pydantic-always-sends-null issue as /regimes: the first live
    // on-demand eval run's metrics had no confidence interval and got a
    // 400 "Expected number, received null" until this schema learned to
    // accept null too.
    await env.DB.prepare(
      `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
       VALUES ('e1', 'slug', 'Title', 'microstructure', 'CANDIDATE', 'h', 'r', 'manual', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', 'e1', '1.0.0', '{"when":{}}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, requested_by, git_sha)
       VALUES ('r1', 'v1', '1.0', 'screen', 'h', 's', 0, '{}', 'running', 'test', 'sha')`
    ).run();

    const res = await internalRoute.request(
      "/runs/r1/metrics",
      {
        method: "POST",
        body: JSON.stringify({
          metrics: [{ segment: "all", metric: "ev_bps", value: 12.5, ci_lo: null, ci_hi: null, meta: null }]
        })
      },
      env
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /internal/runs/:id/verdict (2026-07: field name + null handling)", () => {
  it("accepts `passed` (not `pass`) on each reason and null for score", async () => {
    // verdictReasonSchema previously required a field named `pass`, but
    // every producer/consumer (the Python client, edges.ts's response
    // shape, the web UI) uses `passed` — a typo meant this endpoint could
    // never accept a real submission until fixed.
    await env.DB.prepare(
      `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
       VALUES ('e1', 'slug', 'Title', 'microstructure', 'CANDIDATE', 'h', 'r', 'manual', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', 'e1', '1.0.0', '{"when":{}}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, requested_by, git_sha)
       VALUES ('r1', 'v1', '1.0', 'screen', 'h', 's', 0, '{}', 'running', 'test', 'sha')`
    ).run();

    const res = await internalRoute.request(
      "/runs/r1/verdict",
      {
        method: "POST",
        body: JSON.stringify({
          verdict: "WATCH",
          score: null,
          reasons: [{ check: "ev_bps_ci_lo", passed: true, value: 5, threshold: 0 }],
          thresholds_version: "v1"
        })
      },
      env
    );
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(`SELECT reasons FROM verdicts WHERE run_id = 'r1'`).first<{
      reasons: string;
    }>();
    expect(JSON.parse(row!.reasons)).toEqual([{ check: "ev_bps_ci_lo", passed: true, value: 5, threshold: 0 }]);
  });
});

describe("GET /internal/backup/dump (2026-07 review Task 7)", () => {
  it("rejects a table name outside the whitelist", async () => {
    const res = await internalRoute.request("/backup/dump?table=sqlite_master", {}, env);
    expect(res.status).toBe(400);
  });

  it("pages through rows using after_rowid, oldest first", async () => {
    // Seed migrations (0002) already populate `instruments`; start paging
    // from whatever the table's current high-water mark is so this test
    // doesn't depend on the exact seed row count.
    const before = await env.DB.prepare(`SELECT MAX(rowid) AS m FROM instruments`).first<{ m: number }>();
    const startRowid = before?.m ?? 0;

    await env.DB.prepare(
      `INSERT INTO instruments (instrument_id, symbol, venue, kind, base, quote, is_active) VALUES (?1, ?1, 'X', 'spot', 'A', 'B', 1)`
    )
      .bind("i1")
      .run();
    await env.DB.prepare(
      `INSERT INTO instruments (instrument_id, symbol, venue, kind, base, quote, is_active) VALUES (?1, ?1, 'X', 'spot', 'A', 'B', 1)`
    )
      .bind("i2")
      .run();

    const page1 = await internalRoute.request(
      `/backup/dump?table=instruments&limit=1&after_rowid=${startRowid}`,
      {},
      env
    );
    const body1 = (await page1.json()) as { rows: { _rowid: number; instrument_id: string }[] };
    expect(body1.rows).toHaveLength(1);
    expect(body1.rows[0]!.instrument_id).toBe("i1");

    const page2 = await internalRoute.request(
      `/backup/dump?table=instruments&limit=1&after_rowid=${body1.rows[0]!._rowid}`,
      {},
      env
    );
    const body2 = (await page2.json()) as { rows: { instrument_id: string }[] };
    expect(body2.rows).toHaveLength(1);
    expect(body2.rows[0]!.instrument_id).toBe("i2");
  });
});

describe("Research Pack data sources (docs/15 SONNET-2)", () => {
  it("GET /internal/dq-issues returns only open issues at/after `since`", async () => {
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status) VALUES (100, 's1', 'DQ-01', 'critical', 'open')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status) VALUES (50, 's1', 'DQ-01', 'warn', 'open')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status) VALUES (200, 's1', 'DQ-01', 'critical', 'resolved')`
    ).run();

    const res = await internalRoute.request("/dq-issues?since=100", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dq_issues: { detected_at: number; severity: string }[] };
    expect(body.dq_issues).toHaveLength(1);
    expect(body.dq_issues[0]?.detected_at).toBe(100);
  });

  it("GET /internal/verdicts joins through eval_runs/edge_versions to the edge title", async () => {
    await env.DB.prepare(
      `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
       VALUES ('e1', 'slug', 'My Edge', 'microstructure', 'TESTING', 'h', 'r', 'manual', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', 'e1', '1.0.0', '{"when":{}}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, requested_by, git_sha)
       VALUES ('r1', 'v1', 'p1', 'screen', 'h', 's', 1, '{}', 'done', 'system', 'sha')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO verdicts (run_id, verdict, reasons, thresholds_version, decided_at) VALUES ('r1', 'REJECT', '[]', 'v1', 500)`
    ).run();

    const res = await internalRoute.request("/verdicts?since=100", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdicts: { verdict: string; run_kind: string; edge_title: string }[] };
    expect(body.verdicts).toEqual([{ verdict: "REJECT", run_kind: "screen", edge_title: "My Edge", decided_at: 500 }]);
  });

  it("GET /internal/readiness-summary tallies readiness across all edges", async () => {
    await env.DB.prepare(
      `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
       VALUES ('e1', 'slug', 'T', 'microstructure', 'IDEA', 'h', 'r', 'manual', 1, 1)`
    ).run();
    const res = await internalRoute.request("/readiness-summary", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready_count: number; blocked_breakdown: { signal_spec_pending: number } };
    expect(body.blocked_breakdown.signal_spec_pending).toBe(1);
    expect(body.ready_count).toBe(0);
  });

  it("POST /internal/ai-outputs records a pack pointer", async () => {
    const res = await internalRoute.request(
      "/ai-outputs",
      {
        method: "POST",
        body: JSON.stringify({
          kind: "briefing",
          ref_date: "2026-07-04",
          model: "template",
          prompt_version: "daily_briefing-1.0",
          content_ref: "packs/briefing/2026-07-04.md"
        })
      },
      env
    );
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(`SELECT kind, content_ref, status FROM ai_outputs`).first<{
      kind: string;
      content_ref: string;
      status: string;
    }>();
    expect(row).toEqual({ kind: "briefing", content_ref: "packs/briefing/2026-07-04.md", status: "draft" });
  });
});
