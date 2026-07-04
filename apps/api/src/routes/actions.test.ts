import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { actionsRoute } from "./actions.js";
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

const VALID_SPEC =
  '{"when":{"cmp":[{"feature":"ret_24h"},">",0]},"entry":{"delay_bars":1,"price":"open"},"exit":{"horizon":"24h"},"direction":"long"}';

async function seedEdgeWithVersion(edgeId: string, status: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
     VALUES (?1, ?1, 'T', 'microstructure', ?2, 'h', 'r', 'manual', 1, 1)`
  )
    .bind(edgeId, status)
    .run();
  await env.DB.prepare(
    `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
     VALUES (?1, ?2, '1.0.0', ?3, '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
  )
    .bind(`v-${edgeId}`, edgeId, VALID_SPEC)
    .run();
  await env.DB.prepare(
    `INSERT INTO feature_defs (feature_id, version, spec, cadence, family, status, created_at)
     VALUES ('v1.ret_24h', 1, '{}', '1h', 'price', 'active', 1)`
  ).run();
}

describe("GET /actions (docs/15 SONNET-7)", () => {
  it("returns an empty list when there's nothing to act on", async () => {
    const res = await actionsRoute.request("/", {}, env);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("surfaces a SCREEN_DONE edge as a review item", async () => {
    await seedEdgeWithVersion("e1", "TESTING");
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, finished_at, requested_by, git_sha)
       VALUES ('r1', 'v-e1', '1.0', 'screen', 'h', 's', 0, '{}', 'done', 100, 'test', 'sha')`
    ).run();

    const res = await actionsRoute.request("/", {}, env);
    const body = (await res.json()) as { items: { kind: string; edge_id: string }[] };
    expect(body.items).toContainEqual(expect.objectContaining({ kind: "review", edge_id: "e1" }));
  });

  it("surfaces a FULL_DONE ADOPT edge still in TESTING as an approval item", async () => {
    await seedEdgeWithVersion("e1", "TESTING");
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, finished_at, requested_by, git_sha)
       VALUES ('r1', 'v-e1', '1.0', 'full', 'h', 's', 0, '{}', 'done', 100, 'test', 'sha')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO verdicts (run_id, verdict, reasons, thresholds_version, decided_at) VALUES ('r1', 'ADOPT', '[]', 'v1', 100)`
    ).run();

    const res = await actionsRoute.request("/", {}, env);
    const body = (await res.json()) as { items: { kind: string; edge_id: string }[] };
    expect(body.items).toContainEqual(expect.objectContaining({ kind: "approval", edge_id: "e1" }));
  });

  it("surfaces a FULL_DONE REJECT edge as a review item, not an approval", async () => {
    await seedEdgeWithVersion("e1", "TESTING");
    await env.DB.prepare(
      `INSERT INTO eval_runs (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, finished_at, requested_by, git_sha)
       VALUES ('r1', 'v-e1', '1.0', 'full', 'h', 's', 0, '{}', 'done', 100, 'test', 'sha')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO verdicts (run_id, verdict, reasons, thresholds_version, decided_at) VALUES ('r1', 'REJECT', '[]', 'v1', 100)`
    ).run();

    const res = await actionsRoute.request("/", {}, env);
    const body = (await res.json()) as { items: { kind: string; edge_id: string }[] };
    expect(body.items).toContainEqual(expect.objectContaining({ kind: "review", edge_id: "e1" }));
  });

  it("surfaces open critical dq_issues but not warn/resolved ones", async () => {
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status) VALUES (100, 's1', 'DQ-01', 'critical', 'open')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status) VALUES (100, 's2', 'DQ-02', 'warn', 'open')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status) VALUES (100, 's3', 'DQ-03', 'critical', 'resolved')`
    ).run();

    const res = await actionsRoute.request("/", {}, env);
    const body = (await res.json()) as { items: { kind: string; title: string }[] };
    const dqItems = body.items.filter((i) => i.kind === "dq");
    expect(dqItems).toHaveLength(1);
    expect(dqItems[0]?.title).toBe("DQ-01");
  });
});
