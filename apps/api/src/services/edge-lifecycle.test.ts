import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { attemptTransition } from "./edge-lifecycle.js";
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

async function seedEdge(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  const base = {
    edge_id: "edge-1",
    slug: "test-edge",
    title: "Test Edge",
    category: "microstructure",
    status: "IDEA",
    hypothesis: "x predicts y",
    rationale: "forced flow",
    counter_evidence: "",
    origin: "manual",
    ...overrides
  };
  await env.DB.prepare(
    `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, counter_evidence, origin, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`
  )
    .bind(
      base.edge_id,
      base.slug,
      base.title,
      base.category,
      base.status,
      base.hypothesis,
      base.rationale,
      base.counter_evidence || null,
      base.origin,
      now
    )
    .run();
  return base;
}

describe("attemptTransition IDEA -> CANDIDATE (docs/05 §2)", () => {
  it("rejects when counter_evidence is empty", async () => {
    const edge = await seedEdge({ counter_evidence: "" });
    const outcome = await attemptTransition(
      env,
      { edge_id: edge.edge_id, status: "IDEA", hypothesis: edge.hypothesis, rationale: edge.rationale, counter_evidence: null },
      "CANDIDATE",
      "user:test",
      "ready"
    );
    expect(outcome.ok).toBe(false);
  });

  it("succeeds and persists the transition once a version + counter_evidence exist", async () => {
    const edge = await seedEdge({ counter_evidence: "Mar 2020 outlier dependence" });
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', ?1, '1.0.0', '{}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{}', ?2, 1)`
    )
      .bind(edge.edge_id, Date.now())
      .run();

    const outcome = await attemptTransition(
      env,
      {
        edge_id: edge.edge_id,
        status: "IDEA",
        hypothesis: edge.hypothesis,
        rationale: edge.rationale,
        counter_evidence: "Mar 2020 outlier dependence"
      },
      "CANDIDATE",
      "user:test",
      "ready"
    );
    expect(outcome.ok).toBe(true);

    const row = await env.DB.prepare(`SELECT status FROM edges WHERE edge_id = ?1`)
      .bind(edge.edge_id)
      .first<{ status: string }>();
    expect(row?.status).toBe("CANDIDATE");

    const transitions = await env.DB.prepare(`SELECT * FROM edge_transitions WHERE edge_id = ?1`)
      .bind(edge.edge_id)
      .all();
    expect(transitions.results).toHaveLength(1);
  });
});

describe("attemptTransition CANDIDATE -> TESTING (docs/05 §2 screen-run guard)", () => {
  // Mirrors research/.../eval/pipeline.py's run_eep() exactly: ev_bps is
  // written under segment "overall", but p_perm is written under segment
  // "wf:oos" only -- pipeline.py never writes a "overall" p_perm row.
  // A previous version of this fixture put both under "overall", which
  // happened to match the (buggy) query edge-lifecycle.ts used to run --
  // masking the fact that in production, where p_perm genuinely only ever
  // lives under wf:oos, the guard could never pass (found live: 0 of 7
  // CANDIDATE edges had ever recorded a CANDIDATE->TESTING attempt despite
  // some already clearing both real gates).
  async function seedScreenRun(edgeId: string, evBps: number, pPerm: number, finishedAt: number) {
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', ?1, '1.0.0', '{}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{}', ?2, 1)`
    )
      .bind(edgeId, Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, finished_at, requested_by, git_sha)
       VALUES ('r1', 'v1', '1.0', 'screen', 'hash', 'snap', 1, '{}', 'done', ?1, 'user:test', 'abc123')`
    )
      .bind(finishedAt)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO eval_metrics (run_id, segment, metric, value) VALUES ('r1', 'overall', 'ev_bps', ?1)`
      ).bind(evBps),
      env.DB.prepare(
        `INSERT INTO eval_metrics (run_id, segment, metric, value) VALUES ('r1', 'wf:oos', 'p_perm', ?1)`
      ).bind(pPerm)
    ]);
  }

  it("rejects when the latest screen run's p_perm is too high", async () => {
    const edge = await seedEdge({ status: "CANDIDATE" });
    await seedScreenRun(edge.edge_id, 5, 0.4, Date.now());
    const outcome = await attemptTransition(
      env,
      { edge_id: edge.edge_id, status: "CANDIDATE", hypothesis: "h", rationale: "r", counter_evidence: "c" },
      "TESTING",
      "user:test",
      "go"
    );
    expect(outcome.ok).toBe(false);
  });

  it("accepts when the latest screen run passes both thresholds", async () => {
    const edge = await seedEdge({ status: "CANDIDATE" });
    await seedScreenRun(edge.edge_id, 8, 0.05, Date.now());
    const outcome = await attemptTransition(
      env,
      { edge_id: edge.edge_id, status: "CANDIDATE", hypothesis: "h", rationale: "r", counter_evidence: "c" },
      "TESTING",
      "user:test",
      "go"
    );
    expect(outcome.ok).toBe(true);
  });

  it("regression: a p_perm row under segment 'overall' (not 'wf:oos') must not satisfy the guard", async () => {
    // pipeline.py never writes a p_perm row under "overall" -- this proves
    // the guard is actually reading the wf:oos row rather than silently
    // reading whatever's under the wrong segment name (the exact bug that
    // made CANDIDATE->TESTING structurally impossible in production).
    const edge = await seedEdge({ status: "CANDIDATE" });
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', ?1, '1.0.0', '{}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{}', ?2, 1)`
    )
      .bind(edge.edge_id, Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, finished_at, requested_by, git_sha)
       VALUES ('r1', 'v1', '1.0', 'screen', 'hash', 'snap', 1, '{}', 'done', ?1, 'user:test', 'abc123')`
    )
      .bind(Date.now())
      .run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO eval_metrics (run_id, segment, metric, value) VALUES ('r1', 'overall', 'ev_bps', 8)`),
      env.DB.prepare(`INSERT INTO eval_metrics (run_id, segment, metric, value) VALUES ('r1', 'overall', 'p_perm', 0.05)`)
    ]);

    const outcome = await attemptTransition(
      env,
      { edge_id: edge.edge_id, status: "CANDIDATE", hypothesis: "h", rationale: "r", counter_evidence: "c" },
      "TESTING",
      "user:test",
      "go"
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("attemptTransition PAPER -> ACTIVE (docs/05 §2 paper-performance guard)", () => {
  // No edge has reached PAPER in production yet, so this path had zero
  // test coverage before -- caught proactively while auditing the same bug
  // class as S-94 (CANDIDATE->TESTING): eval/pipeline.py's `_bundle_rows`
  // writes a plain "sharpe" MetricRow under wf:oos with no CI at all (only
  // "sharpe_bootstrap", from the separate bootstrap_ci() call, carries
  // ci_lo/ci_hi). paperPerformance() queried `metric='sharpe'` expecting a
  // CI, which is always null there -- so `ctx.PAPER_to_ACTIVE` could never
  // be populated and this guard would have failed unconditionally the
  // moment a real edge reached PAPER, identical in shape to S-94.
  async function seedPaperEdge(args: { oosSharpeMetric: string; ciLo: number; ciHi: number }) {
    const edge = await seedEdge({ status: "PAPER" });
    await env.DB.prepare(
      `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
       VALUES ('v1', ?1, '1.0.0', '{}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2}', ?2, 1)`
    )
      .bind(edge.edge_id, Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, finished_at, requested_by, git_sha)
       VALUES ('r1', 'v1', '1.0', 'full', 'hash', 'snap', 1, '{}', 'done', ?1, 'user:test', 'abc123')`
    )
      .bind(Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO eval_metrics (run_id, segment, metric, value, ci_lo, ci_hi) VALUES ('r1', 'wf:oos', ?1, 1.2, ?2, ?3)`
    )
      .bind(args.oosSharpeMetric, args.ciLo, args.ciHi)
      .run();

    const now = Date.now();
    const start = now - 35 * 86_400_000;
    const netReturns = [10, 12, 8, 11, 9, 10, 13, 7, 12, 10];
    const stmt = env.DB.prepare(
      `INSERT INTO paper_signals (signal_id, edge_version_id, status, direction, ts_signal, ret_bps, ret_net_bps, trigger_snapshot)
       VALUES (?1, 'v1', 'closed', 'long', ?2, ?3, ?4, '{}')`
    );
    await env.DB.batch(
      netReturns.map((netBps, i) => stmt.bind(`sig-${i}`, start + i * 3 * 86_400_000, netBps + 3, netBps))
    );
    return edge;
  }

  it("regression: a CI-less 'sharpe' row under wf:oos must not satisfy the guard", async () => {
    // Mirrors what pipeline.py actually writes: ci_lo/ci_hi both null.
    const edge = await seedPaperEdge({ oosSharpeMetric: "sharpe", ciLo: null as unknown as number, ciHi: null as unknown as number });
    const outcome = await attemptTransition(
      env,
      { edge_id: edge.edge_id, status: "PAPER", hypothesis: "h", rationale: "r", counter_evidence: "c" },
      "ACTIVE",
      "user:test",
      "go"
    );
    expect(outcome.ok).toBe(false);
  });

  it("accepts PAPER -> ACTIVE when paper performance clears the OOS sharpe_bootstrap CI lower bound", async () => {
    const edge = await seedPaperEdge({ oosSharpeMetric: "sharpe_bootstrap", ciLo: 0.05, ciHi: 0.5 });
    const outcome = await attemptTransition(
      env,
      { edge_id: edge.edge_id, status: "PAPER", hypothesis: "h", rationale: "r", counter_evidence: "c" },
      "ACTIVE",
      "user:test",
      "go"
    );
    expect(outcome.ok).toBe(true);
  });
});
