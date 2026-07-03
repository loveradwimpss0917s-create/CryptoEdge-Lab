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
