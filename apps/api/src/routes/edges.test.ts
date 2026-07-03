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

async function seedEdgeWithVersion(env: Env) {
  await env.DB.prepare(
    `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
     VALUES ('e1', 'slug', 'Title', 'microstructure', 'TESTING', 'h', 'r', 'manual', 1, 1)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
     VALUES ('v1', 'e1', '1.0.0', '{"when":{}}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
  ).run();
}

describe("GET /edges/:id runs (2026-07 review Task 8)", () => {
  it("returns an empty runs array when the edge has no current version", async () => {
    await env.DB.prepare(
      `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
       VALUES ('e1', 'slug', 'Title', 'microstructure', 'IDEA', 'h', 'r', 'manual', 1, 1)`
    ).run();

    const res = await edgesRoute.request("/e1", {}, env);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it("returns up to 5 recent runs, newest first, each with verdict reasons and wf:oos metrics", async () => {
    await seedEdgeWithVersion(env);

    const runStmt = env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, finished_at, requested_by, git_sha)
       VALUES (?1, 'v1', '1.0', 'full', 'h', 's', 0, '{}', 'done', ?2, 'test', 'sha')`
    );
    await Promise.all([1, 2, 3, 4, 5, 6, 7].map((i) => runStmt.bind(`r${i}`, i * 1000).run()));

    await env.DB.prepare(
      `INSERT INTO verdicts (run_id, verdict, reasons, thresholds_version, decided_at)
       VALUES ('r7', 'ADOPT', ?1, 'v1', 7000)`
    )
      .bind(JSON.stringify([{ check: "ev_bps_ci_lo", passed: true, value: 5, threshold: 0 }]))
      .run();
    const metricStmt = env.DB.prepare(
      `INSERT INTO eval_metrics (run_id, segment, metric, value) VALUES ('r7', 'wf:oos', ?1, ?2)`
    );
    await metricStmt.bind("ev_bps", 12.5).run();
    await metricStmt.bind("sharpe", 1.2).run();
    await metricStmt.bind("dsr", 0.9).run();
    await metricStmt.bind("p_perm", 0.01).run();

    const res = await edgesRoute.request("/e1", {}, env);
    const body = (await res.json()) as {
      runs: {
        run_id: string;
        verdict: { verdict: string; reasons: { check: string; passed: boolean }[] } | null;
        metrics: { ev_bps: number | null; sharpe: number | null; dsr: number | null; p_perm: number | null };
      }[];
    };

    expect(body.runs).toHaveLength(5);
    expect(body.runs[0]!.run_id).toBe("r7"); // newest first
    expect(body.runs[0]!.verdict?.verdict).toBe("ADOPT");
    expect(body.runs[0]!.verdict?.reasons[0]).toMatchObject({ check: "ev_bps_ci_lo", passed: true });
    expect(body.runs[0]!.metrics).toEqual({ ev_bps: 12.5, sharpe: 1.2, dsr: 0.9, p_perm: 0.01 });

    // Runs without a verdict/metrics yet still show up, just with nulls.
    const runWithoutVerdict = body.runs.find((r) => r.run_id === "r6")!;
    expect(runWithoutVerdict.verdict).toBeNull();
    expect(runWithoutVerdict.metrics).toEqual({ ev_bps: null, sharpe: null, dsr: null, p_perm: null });
  });
});
