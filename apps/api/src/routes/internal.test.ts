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
