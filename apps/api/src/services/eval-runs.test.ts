import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { reapStuckEvalRuns } from "./eval-runs.js";
import type { Env } from "../env.js";

let fake: FakeD1;
let env: Env;
let seeded = false;

beforeEach(() => {
  fake = new FakeD1();
  env = { DB: fake as unknown as D1Database } as Env;
  seeded = false;
});

afterEach(() => {
  fake.close();
});

async function seedEdgeWithVersion(env: Env): Promise<void> {
  if (seeded) return;
  seeded = true;
  await env.DB.prepare(
    `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
     VALUES ('e1', 'slug', 'Title', 'microstructure', 'TESTING', 'h', 'r', 'manual', 1, 1)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO edge_versions (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
     VALUES ('v1', 'e1', '1.0.0', '{"when":{"cmp":[{"feature":"ret_24h"},">",0]},"entry":{"delay_bars":1,"price":"open"},"exit":{"horizon":"24h"},"direction":"long"}', '{}', 'BTCUSDT.BINANCE.PERP', 'long', '24h', '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
  ).run();
}

async function insertRun(runId: string, startedAt: number, status = "running"): Promise<void> {
  await seedEdgeWithVersion(env);
  await env.DB.prepare(
    `INSERT INTO eval_runs
       (run_id, edge_version_id, protocol_version, run_kind, dataset_hash, snapshot_id, seed, config, status, started_at, requested_by, git_sha)
     VALUES (?1, 'v1', '1', 'screen', 'h', 's1', 1, '{}', ?2, ?3, 'system', 'abc')`
  )
    .bind(runId, status, startedAt)
    .run();
}

describe("reapStuckEvalRuns (docs/19 S-91)", () => {
  it("marks a run stuck in 'running' past the threshold as 'timeout'", async () => {
    await insertRun("r1", Date.now() - 7 * 60 * 60 * 1000);
    await reapStuckEvalRuns(env);

    const row = await env.DB.prepare(`SELECT status, finished_at FROM eval_runs WHERE run_id = 'r1'`).first<{
      status: string;
      finished_at: number | null;
    }>();
    expect(row?.status).toBe("timeout");
    expect(row?.finished_at).not.toBeNull();
  });

  it("leaves a recently-started running run alone", async () => {
    await insertRun("r2", Date.now() - 5 * 60 * 1000);
    await reapStuckEvalRuns(env);

    const row = await env.DB.prepare(`SELECT status FROM eval_runs WHERE run_id = 'r2'`).first<{ status: string }>();
    expect(row?.status).toBe("running");
  });

  it("leaves already-done runs alone", async () => {
    await insertRun("r3", Date.now() - 7 * 60 * 60 * 1000, "done");
    await reapStuckEvalRuns(env);

    const row = await env.DB.prepare(`SELECT status FROM eval_runs WHERE run_id = 'r3'`).first<{ status: string }>();
    expect(row?.status).toBe("done");
  });
});
