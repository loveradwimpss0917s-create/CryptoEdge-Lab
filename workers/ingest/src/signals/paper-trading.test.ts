import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { computeRetBps, parseHorizonMs, roundTripCostBps, runPaperTrading } from "./paper-trading.js";
import type { Env } from "../env.js";

describe("parseHorizonMs (mirrors research/eval/backtest.py's unit table)", () => {
  it.each([
    ["30m", 30 * 60_000],
    ["2h", 2 * 3_600_000],
    ["72h", 72 * 3_600_000],
    ["1d", 86_400_000]
  ])("parses %s", (horizon, expected) => {
    expect(parseHorizonMs(horizon)).toBe(expected);
  });

  it("returns null for an unsupported format", () => {
    expect(parseHorizonMs("2w")).toBeNull();
  });
});

describe("computeRetBps (mirrors research/eval/backtest.py's ret_bps formula)", () => {
  it("computes long returns as (exit/entry - 1) * 10000", () => {
    expect(computeRetBps("long", 100, 101)).toBeCloseTo(100);
  });

  it("computes short returns as (entry/exit - 1) * 10000", () => {
    expect(computeRetBps("short", 100, 99)).toBeCloseTo(101.01, 1);
  });
});

describe("roundTripCostBps", () => {
  it("doubles taker+slippage for a round trip", () => {
    expect(roundTripCostBps({ taker_bps: 4, slippage_bps: 2 })).toBe(12);
  });
});

let fake: FakeD1;
let env: Env;

beforeEach(() => {
  fake = new FakeD1();
  env = { DB: fake as unknown as D1Database } as Env;
});

afterEach(() => {
  fake.close();
});

async function seedPaperEdge(args: {
  edgeId: string;
  versionId: string;
  signalSpec: object;
  direction: string;
  horizon: string;
  instrumentId?: string;
}): Promise<void> {
  const instrumentId = args.instrumentId ?? "BTCUSDT.BINANCE.PERP";
  await env.DB.prepare(
    `INSERT INTO edges (edge_id, slug, title, category, status, hypothesis, rationale, origin, created_at, updated_at)
     VALUES (?1, ?1, 'T', 'seasonality', 'PAPER', 'h', 'r', 'manual', 1, 1)`
  )
    .bind(args.edgeId)
    .run();
  await env.DB.prepare(
    `INSERT INTO edge_versions
       (version_id, edge_id, semver, signal_spec, params, instrument_id, direction, horizon, cost_model, created_at, is_current)
     VALUES (?1, ?2, '1.0.0', ?3, '{}', ?4, ?5, ?6, '{"taker_bps":4,"slippage_bps":2,"funding_included":false}', 1, 1)`
  )
    .bind(args.versionId, args.edgeId, JSON.stringify(args.signalSpec), instrumentId, args.direction, args.horizon)
    .run();
}

async function seedCandle(instrumentId: string, ts: number, open: number, close: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO candles (instrument_id, tf, ts, open, high, low, close, volume, ingested_at)
     VALUES (?1, '1m', ?2, ?3, ?3, ?3, ?4, 0, ?2)`
  )
    .bind(instrumentId, ts, open, close)
    .run();
}

describe("runPaperTrading (docs/15 SONNET-5)", () => {
  it("enters a new paper_signal when an event-based when condition fires", async () => {
    const now = 10_000_000;
    await seedPaperEdge({
      edgeId: "e1",
      versionId: "v1",
      signalSpec: {
        when: { event: { type: "usdt_mint", min_magnitude: 1_000_000_000 } },
        entry: { delay_bars: 1, price: "open" },
        exit: { horizon: "30m" },
        direction: "long"
      },
      direction: "long",
      horizon: "30m"
    });
    await env.DB.prepare(
      `INSERT INTO events (event_id, event_type, ts, source_id, dedupe_key, magnitude)
       VALUES ('ev1', 'usdt_mint', ?1, 'etherscan', 'ev1', 2000000000)`
    )
      .bind(now - 60_000)
      .run();
    await seedCandle("BTCUSDT.BINANCE.PERP", now, 50_000, 50_100);

    const result = await runPaperTrading(env, now);
    expect(result.entered).toBe(1);

    const row = await env.DB.prepare(`SELECT status, direction, entry_px, ts_entry FROM paper_signals`).first<{
      status: string;
      direction: string;
      entry_px: number;
      ts_entry: number;
    }>();
    expect(row).toEqual({ status: "open", direction: "long", entry_px: 50_000, ts_entry: now });
  });

  it("does not fire twice while a signal is already open for the same edge_version", async () => {
    const now = 10_000_000;
    await seedPaperEdge({
      edgeId: "e1",
      versionId: "v1",
      signalSpec: {
        when: { event: { type: "usdt_mint", min_magnitude: 1_000_000_000 } },
        entry: { delay_bars: 1, price: "open" },
        exit: { horizon: "30m" },
        direction: "long"
      },
      direction: "long",
      horizon: "30m"
    });
    await env.DB.prepare(
      `INSERT INTO events (event_id, event_type, ts, source_id, dedupe_key, magnitude)
       VALUES ('ev1', 'usdt_mint', ?1, 'etherscan', 'ev1', 2000000000)`
    )
      .bind(now - 60_000)
      .run();
    await seedCandle("BTCUSDT.BINANCE.PERP", now, 50_000, 50_100);

    await runPaperTrading(env, now);
    const second = await runPaperTrading(env, now + 5 * 60_000);
    expect(second.entered).toBe(0);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM paper_signals`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("skips a when condition that references a feature (no live Feature Store reader)", async () => {
    const now = 10_000_000;
    await seedPaperEdge({
      edgeId: "e1",
      versionId: "v1",
      signalSpec: {
        when: { cmp: [{ feature: "ret_24h" }, ">", 0] },
        entry: { delay_bars: 1, price: "open" },
        exit: { horizon: "30m" },
        direction: "long"
      },
      direction: "long",
      horizon: "30m"
    });
    await seedCandle("BTCUSDT.BINANCE.PERP", now, 50_000, 50_100);

    const result = await runPaperTrading(env, now);
    expect(result.entered).toBe(0);
  });

  it("settles an open signal once its horizon has elapsed, computing ret_bps/ret_net_bps", async () => {
    const entryTs = 10_000_000;
    await seedPaperEdge({
      edgeId: "e1",
      versionId: "v1",
      signalSpec: {
        when: { event: { type: "usdt_mint" } },
        entry: { delay_bars: 1, price: "open" },
        exit: { horizon: "30m" },
        direction: "long"
      },
      direction: "long",
      horizon: "30m"
    });
    await env.DB.prepare(
      `INSERT INTO paper_signals (signal_id, edge_version_id, status, direction, ts_signal, ts_entry, entry_px, trigger_snapshot)
       VALUES ('s1', 'v1', 'open', 'long', ?1, ?1, 50000, '{}')`
    )
      .bind(entryTs)
      .run();

    const now = entryTs + 30 * 60_000; // horizon elapsed
    await seedCandle("BTCUSDT.BINANCE.PERP", now, 50_050, 50_500);

    const result = await runPaperTrading(env, now);
    expect(result.settled).toBe(1);

    const row = await env.DB.prepare(`SELECT status, exit_px, ret_bps, ret_net_bps FROM paper_signals WHERE signal_id = 's1'`).first<{
      status: string;
      exit_px: number;
      ret_bps: number;
      ret_net_bps: number;
    }>();
    expect(row?.status).toBe("closed");
    expect(row?.exit_px).toBe(50_500);
    expect(row?.ret_bps).toBeCloseTo(((50_500 / 50_000 - 1) * 10_000));
    expect(row?.ret_net_bps).toBeCloseTo(((50_500 / 50_000 - 1) * 10_000) - 12);
  });

  it("does not settle an open signal before its horizon has elapsed", async () => {
    const entryTs = 10_000_000;
    await seedPaperEdge({
      edgeId: "e1",
      versionId: "v1",
      signalSpec: {
        when: { event: { type: "usdt_mint" } },
        entry: { delay_bars: 1, price: "open" },
        exit: { horizon: "30m" },
        direction: "long"
      },
      direction: "long",
      horizon: "30m"
    });
    await env.DB.prepare(
      `INSERT INTO paper_signals (signal_id, edge_version_id, status, direction, ts_signal, ts_entry, entry_px, trigger_snapshot)
       VALUES ('s1', 'v1', 'open', 'long', ?1, ?1, 50000, '{}')`
    )
      .bind(entryTs)
      .run();

    const result = await runPaperTrading(env, entryTs + 10 * 60_000); // horizon not yet elapsed
    expect(result.settled).toBe(0);
  });
});
