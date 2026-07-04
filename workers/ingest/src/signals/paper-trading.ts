// paper_signals writer (docs/05, docs/14 §6, docs/15 SONNET-5, docs/16 §4).
// paper_signals never had a writer anywhere in the codebase before this --
// meaning PAPER->ACTIVE (docs/05 §2) could never be satisfied. Runs every
// tick-5m for every PAPER-status Edge's current_version.
//
// V1 scope, documented rather than silently approximated:
// - Only `when` expressions with no feature (`cmp`) references are
//   supported live -- Feature Store values (research/features_sync.py)
//   live in R2 Parquet, which this Worker has no live reader for. Edges
//   whose `when` references a feature are skipped every tick (not
//   fabricated as "no signal"), same as `computeReadinessForEdges`
//   already reflects via readiness rather than silently degrading here.
// - `entry.delay_bars` > 1 is not supported (skipped) -- with no explicit
//   bar-timeframe field on signal_spec, "1 bar" is treated as "the next
//   tick-5m run" (~5 min), which is the only delay this Worker's tick
//   cadence can express without fabricating a timeframe. Every P0 seed
//   Edge already uses delay_bars=1.
// - Only the fixed `exit: {horizon}` variant is supported (not
//   `{cond, max_horizon}`), which would need re-evaluating `cond` every
//   tick against a feature/event series this Worker may not have live.
// - Entry/exit price uses the latest 1m candle's open/close at the
//   settlement tick, not a historical bar exactly `delay_bars`/`horizon`
//   bars later -- live paper trading runs on wall-clock time, not the
//   research engine's discrete historical bar grid (research/eval/
//   backtest.py). ret_bps/round-trip-cost formulas are kept identical to
//   backtest.py so PAPER and FULL runs stay comparable (docs/05 §2 gate).
// - Dedupe: at most one open (unsettled) paper_signals row per
//   edge_version_id at a time -- a second fire while a position is still
//   open is skipped, matching a one-position-per-Edge paper model.

import { newId } from "@cryptoedge/shared";
import { referencedEventTypes, referencedFeatures, signalSpecSchema, type BoolExpr } from "@cryptoedge/schema";
import { evaluateAt, type DslEvalInput } from "./dsl-evaluator.js";
import { recordWrites } from "../db.js";
import type { Env } from "../env.js";

const HORIZON_RE = /^(\d+)(m|h|d)$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Mirrors research/eval/backtest.py's `parse_horizon_bars` unit table (docs/05 §9). */
export function parseHorizonMs(horizon: string): number | null {
  const match = HORIZON_RE.exec(horizon.trim());
  if (!match) return null;
  const [, amount, unit] = match;
  return Number(amount) * (UNIT_MS[unit as string] ?? 0);
}

/** Mirrors research/eval/backtest.py's `run_backtest` ret_bps formula exactly. */
export function computeRetBps(direction: "long" | "short", entryPx: number, exitPx: number): number {
  return direction === "long" ? (exitPx / entryPx - 1) * 10_000 : (entryPx / exitPx - 1) * 10_000;
}

/** Mirrors research/eval/backtest.py's `CostModel.round_trip_bps`. */
export function roundTripCostBps(costModel: { taker_bps: number; slippage_bps: number }): number {
  return (costModel.taker_bps + costModel.slippage_bps) * 2;
}

interface PaperEdgeVersionRow {
  edge_id: string;
  version_id: string;
  signal_spec: string;
  instrument_id: string;
  direction: string;
  horizon: string;
  cost_model: string;
}

interface LatestCandle {
  open: number;
  close: number;
}

async function latestCandle(env: Env, instrumentId: string): Promise<LatestCandle | null> {
  return env.DB.prepare(
    `SELECT open, close FROM candles WHERE instrument_id = ?1 AND tf = '1m' ORDER BY ts DESC LIMIT 1`
  )
    .bind(instrumentId)
    .first<LatestCandle>();
}

async function hasOpenSignal(env: Env, versionId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM paper_signals WHERE edge_version_id = ?1 AND status = 'open' LIMIT 1`)
    .bind(versionId)
    .first();
  return row !== null;
}

// Event recency window for live detection: wider than the tick-5m cadence
// so timing jitter (a slow tick, a missed tick) can't silently drop an
// event-triggered fire. Not a research-grade look-back -- just enough to
// bridge two ticks.
const EVENT_LOOKBACK_MS = 15 * 60_000;

async function buildLiveDslInput(env: Env, when: BoolExpr, now: number): Promise<DslEvalInput> {
  const eventTypes = [...referencedEventTypes(when)];
  const events =
    eventTypes.length === 0
      ? []
      : (
          await env.DB.prepare(
            `SELECT event_type, magnitude FROM events WHERE ts >= ?1 AND ts <= ?2 AND event_type IN (${eventTypes
              .map((_, i) => `?${i + 3}`)
              .join(",")})`
          )
            .bind(now - EVENT_LOOKBACK_MS, now, ...eventTypes)
            .all<{ event_type: string; magnitude: number | null }>()
        ).results ?? [];

  const today = new Date(now).toISOString().slice(0, 10);
  const regimeRow = await env.DB.prepare(`SELECT trend, vol, liquidity FROM regimes_daily WHERE dt = ?1`)
    .bind(today)
    .first<{ trend: "up" | "down" | "range"; vol: "low" | "high" | "extreme"; liquidity: "normal" | "stressed" }>();

  return {
    timestamps: [now],
    features: {},
    events: [events.map((e) => ({ type: e.event_type, magnitude: e.magnitude ?? 0 }))],
    regimes: [regimeRow ?? null]
  };
}

async function detectAndEnter(env: Env, edgeVersion: PaperEdgeVersionRow, now: number): Promise<boolean> {
  const parsed = signalSpecSchema.safeParse(JSON.parse(edgeVersion.signal_spec));
  if (!parsed.success) return false;
  const spec = parsed.data;

  // Direction/horizon come from the edge_versions columns, not signal_spec's
  // own (redundant) copies -- matching research/jobs/on_demand.py's
  // convention exactly (`edge_version["direction"]`/`["horizon"]`) so PAPER
  // and FULL runs read the same canonical values.
  if (edgeVersion.direction !== "long" && edgeVersion.direction !== "short") return false; // signal_sign unsupported
  const direction = edgeVersion.direction;

  if (referencedFeatures(spec.when).size > 0) return false; // no live Feature Store reader (see module docstring)
  if (!("horizon" in spec.exit)) return false; // {cond, max_horizon} unsupported
  if (spec.entry.delay_bars > 1) return false;
  if (await hasOpenSignal(env, edgeVersion.version_id)) return false;

  const input = await buildLiveDslInput(env, spec.when, now);
  if (!evaluateAt(spec.when, input, 0)) return false;

  const candle = await latestCandle(env, edgeVersion.instrument_id);
  if (!candle) return false; // no price to enter at -- don't fabricate

  await env.DB.prepare(
    `INSERT INTO paper_signals
       (signal_id, edge_version_id, status, direction, ts_signal, ts_entry, entry_px, trigger_snapshot)
     VALUES (?1, ?2, 'open', ?3, ?4, ?4, ?5, ?6)`
  )
    .bind(newId(), edgeVersion.version_id, direction, now, candle.open, JSON.stringify(input))
    .run();
  await recordWrites(env, "d1_writes", 1);
  return true;
}

interface OpenSignalRow {
  signal_id: string;
  edge_version_id: string;
  ts_entry: number;
  entry_px: number;
  direction: "long" | "short";
  instrument_id: string;
  horizon: string;
  cost_model: string;
}

async function settleOpenSignals(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT p.signal_id, p.edge_version_id, p.ts_entry, p.entry_px, p.direction,
            v.instrument_id, v.horizon, v.cost_model
     FROM paper_signals p JOIN edge_versions v ON v.version_id = p.edge_version_id
     WHERE p.status = 'open'`
  ).all<OpenSignalRow>();

  let settled = 0;
  // Sequential by design (same rationale as index.ts's runAdapters): keeps
  // D1 write ordering predictable across settled signals within one tick.
  /* eslint-disable no-await-in-loop */
  for (const row of results ?? []) {
    const horizonMs = parseHorizonMs(row.horizon);
    if (horizonMs === null || now < row.ts_entry + horizonMs) continue;

    const candle = await latestCandle(env, row.instrument_id);
    if (!candle) continue; // can't settle without a price -- try again next tick

    const retBps = computeRetBps(row.direction, row.entry_px, candle.close);
    const costModel = JSON.parse(row.cost_model) as { taker_bps: number; slippage_bps: number };
    const retNetBps = retBps - roundTripCostBps(costModel);

    await env.DB.prepare(
      `UPDATE paper_signals SET status = 'closed', ts_exit = ?1, exit_px = ?2, ret_bps = ?3, ret_net_bps = ?4
       WHERE signal_id = ?5`
    )
      .bind(now, candle.close, retBps, retNetBps, row.signal_id)
      .run();
    await recordWrites(env, "d1_writes", 1);
    settled += 1;
  }
  /* eslint-enable no-await-in-loop */
  return settled;
}

export interface PaperTradingResult {
  entered: number;
  settled: number;
}

export async function runPaperTrading(env: Env, now: number = Date.now()): Promise<PaperTradingResult> {
  const settled = await settleOpenSignals(env, now);

  const { results } = await env.DB.prepare(
    `SELECT e.edge_id, v.version_id, v.signal_spec, v.instrument_id, v.direction, v.horizon, v.cost_model
     FROM edges e JOIN edge_versions v ON v.edge_id = e.edge_id AND v.is_current = 1
     WHERE e.status = 'PAPER'`
  ).all<PaperEdgeVersionRow>();

  let entered = 0;
  for (const row of results ?? []) {
    // eslint-disable-next-line no-await-in-loop
    if (await detectAndEnter(env, row, now)) entered += 1;
  }

  return { entered, settled };
}
