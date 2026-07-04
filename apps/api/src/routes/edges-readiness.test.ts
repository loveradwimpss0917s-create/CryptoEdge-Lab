// Research Readiness (docs/06 §7, 2026-07 design): exercises the GET
// /edges (readiness per row), GET /edges/:id (readiness on the single
// edge), and GET /edges/readiness-summary endpoints end to end against
// FakeD1, covering the DATA_PENDING vs FEATURE_PENDING distinction Edge
// Pack v1 Phase 1 surfaced live (ls_top_trader_z_30d registered but
// long_short_ratios empty).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { edgesRoute } from "./edges.js";
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

async function insertEdge(env: Env, id: string, status: string, readinessClass?: string, blockers?: string[]) {
  await env.DB.prepare(
    `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at, readiness_class, readiness_blockers)
     VALUES (?1, ?1, 'Title', 'microstructure', ?2, 'h', 'r', 'manual', 1, 1, ?3, ?4)`
  )
    .bind(id, status, readinessClass ?? null, blockers ? JSON.stringify(blockers) : null)
    .run();
}

async function insertVersion(env: Env, edgeId: string, versionId: string, signalSpec: unknown) {
  await env.DB.prepare(
    `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
     VALUES (?1, ?2, '1.0.0', ?3, '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
  )
    .bind(versionId, edgeId, JSON.stringify(signalSpec))
    .run();
}

describe("GET /edges readiness (2026-07 design, Research Readiness)", () => {
  it("BUILD_PENDING when no version exists and readiness_class is C/D, carrying planBlockers", async () => {
    await insertEdge(env, "e1", "IDEA", "C", ["Coinbase価格データ未実装"]);
    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { edge_id: string; readiness: { state: string; missing: unknown } }[] };
    expect(body.edges[0]!.readiness).toEqual({
      state: "BUILD_PENDING",
      missing: { build: ["Coinbase価格データ未実装"] }
    });
  });

  it("SIGNAL_SPEC_PENDING when no version exists and readiness_class is A/B or unclassified", async () => {
    await insertEdge(env, "e1", "IDEA", "A");
    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { readiness: { state: string } }[] };
    expect(body.edges[0]!.readiness.state).toBe("SIGNAL_SPEC_PENDING");
  });

  it("READY when a version exists referencing only a registered, data-backed feature", async () => {
    await insertEdge(env, "e1", "IDEA");
    await insertVersion(env, "e1", "v1", {
      when: { cmp: [{ feature: "ret_24h" }, ">", 0] },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "24h" },
      direction: "long"
    });
    await env.DB.prepare(
      `INSERT INTO feature_defs (feature_id, version, spec, cadence, family, status, created_at)
       VALUES ('v1.ret_24h', 1, '{}', '1h', 'price', 'active', 1)`
    ).run();

    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { readiness: { state: string } }[] };
    expect(body.edges[0]!.readiness.state).toBe("READY");
  });

  it("FEATURE_PENDING when the referenced feature has no feature_defs row at all", async () => {
    await insertEdge(env, "e1", "IDEA");
    await insertVersion(env, "e1", "v1", {
      when: { cmp: [{ feature: "some_未定義_feature" }, ">", 0] },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "24h" },
      direction: "long"
    });

    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { readiness: { state: string; missing: unknown } }[] };
    expect(body.edges[0]!.readiness).toEqual({
      state: "FEATURE_PENDING",
      missing: { feature: ["some_未定義_feature"] }
    });
  });

  it("DATA_PENDING when a deriv feature is registered but its base table is empty (the ls_top_trader_z_30d case)", async () => {
    await insertEdge(env, "e1", "IDEA");
    await insertVersion(env, "e1", "v1", {
      when: { cmp: [{ feature: "ls_top_trader_z_30d" }, ">", 2] },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "48h" },
      direction: "short"
    });
    await env.DB.prepare(
      `INSERT INTO feature_defs (feature_id, version, spec, cadence, family, status, created_at)
       VALUES ('v1.ls_top_trader_z_30d', 1, '{}', '1h', 'deriv', 'active', 1)`
    ).run();
    // long_short_ratios intentionally left empty.

    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { readiness: { state: string; missing: unknown } }[] };
    expect(body.edges[0]!.readiness).toEqual({
      state: "DATA_PENDING",
      missing: { data: ["ls_top_trader_z_30d"] }
    });
  });

  it("DATA_PENDING when a referenced event type has zero rows", async () => {
    await insertEdge(env, "e1", "IDEA");
    await insertVersion(env, "e1", "v1", {
      when: { event: { type: "fomc" } },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "24h" },
      direction: "long"
    });

    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { readiness: { state: string; missing: unknown } }[] };
    expect(body.edges[0]!.readiness).toEqual({ state: "DATA_PENDING", missing: { event: ["fomc"] } });
  });

  it("SCREEN_DONE once a screen run has status='done', even without a verdict yet", async () => {
    await insertEdge(env, "e1", "IDEA");
    await insertVersion(env, "e1", "v1", {
      when: { cmp: [{ feature: "ret_24h" }, ">", 0] },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "24h" },
      direction: "long"
    });
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, requested_by, git_sha)
       VALUES ('r1', 'v1', '1.0', 'screen', 'h', 's', 0, '{}', 'done', 'test', 'sha')`
    ).run();

    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { readiness: { state: string } }[] };
    expect(body.edges[0]!.readiness.state).toBe("SCREEN_DONE");
  });

  it("VALIDATED_PLUS once lifecycle status is past TESTING, regardless of runs", async () => {
    await insertEdge(env, "e1", "PAPER");
    const res = await edgesRoute.request("/", {}, env);
    const body = (await res.json()) as { edges: { readiness: { state: string } }[] };
    expect(body.edges[0]!.readiness.state).toBe("VALIDATED_PLUS");
  });
});

describe("GET /edges/readiness-summary", () => {
  it("tallies edges into ready_count / review_pending / blocked_breakdown", async () => {
    await insertEdge(env, "ready1", "IDEA");
    await insertVersion(env, "ready1", "v-ready1", {
      when: { cmp: [{ feature: "ret_24h" }, ">", 0] },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "24h" },
      direction: "long"
    });
    await env.DB.prepare(
      `INSERT INTO feature_defs (feature_id, version, spec, cadence, family, status, created_at)
       VALUES ('v1.ret_24h', 1, '{}', '1h', 'price', 'active', 1)`
    ).run();
    await insertEdge(env, "spec-pending", "IDEA", "A");
    await insertEdge(env, "build-pending", "IDEA", "C", ["something未実装"]);

    const res = await edgesRoute.request("/readiness-summary", {}, env);
    const body = (await res.json()) as {
      ready_count: number;
      review_pending: { screen: number; full: number };
      blocked_breakdown: { build_pending: number; signal_spec_pending: number; feature_pending: number; data_pending: number };
    };
    expect(body.ready_count).toBe(1);
    expect(body.review_pending).toEqual({ screen: 0, full: 0 });
    expect(body.blocked_breakdown.build_pending).toBe(1);
    expect(body.blocked_breakdown.signal_spec_pending).toBe(1);
  });
});
