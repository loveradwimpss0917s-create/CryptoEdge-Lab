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
        `INSERT INTO eval_metrics (run_id, segment, metric, value) VALUES ('r1', 'overall', 'p_perm', ?1)`
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
});
