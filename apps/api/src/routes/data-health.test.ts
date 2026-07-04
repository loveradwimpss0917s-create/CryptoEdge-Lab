import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { dataHealthRoute } from "./data-health.js";
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

describe("GET /data-health (docs/15 SONNET-4)", () => {
  it("returns an empty rollup when nothing has ingested yet", async () => {
    const res = await dataHealthRoute.request("/", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overall_quality_score: number | null; sources: unknown[] };
    expect(body.overall_quality_score).toBeNull();
    expect(body.sources.length).toBeGreaterThan(0); // migration 0002 seeds data_sources
  });

  it("groups streams under their source and attaches open issue counts", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO ingest_state (stream_id, watermark_ts, last_run_at, last_status, consecutive_errors)
       VALUES ('okx_rest:candles_1m:BTCUSDT.BINANCE.PERP', ?1, ?1, 'ok', 0)`
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status)
       VALUES (?1, 'okx_rest:candles_1m:BTCUSDT.BINANCE.PERP', 'DQ-01', 'warn', 'open')`
    )
      .bind(now)
      .run();

    const res = await dataHealthRoute.request("/", {}, env);
    const body = (await res.json()) as {
      overall_quality_score: number;
      sources: { source_id: string; streams: { stream_id: string; quality_score: number; open_issues: { warn: number } }[] }[];
    };
    const okx = body.sources.find((s) => s.source_id === "okx_rest")!;
    expect(okx.streams).toHaveLength(1);
    expect(okx.streams[0]?.quality_score).toBeCloseTo(1);
    expect(okx.streams[0]?.open_issues.warn).toBe(1);
    expect(body.overall_quality_score).toBeCloseTo(1);
  });

  it("excludes resolved issues from open_issues counts and the recent list", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, status, resolved_at)
       VALUES (?1, 's1', 'DQ-02', 'critical', 'resolved', ?1)`
    )
      .bind(now)
      .run();

    const res = await dataHealthRoute.request("/", {}, env);
    const body = (await res.json()) as { open_issues: unknown[] };
    expect(body.open_issues).toHaveLength(0);
  });
});
