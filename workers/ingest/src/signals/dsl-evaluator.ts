// Signal DSL evaluator (docs/05 §9). This file and
// research/src/cryptoedge_research/dsl/evaluator.py implement the *same*
// semantics independently — one runs here for live paper-signal detection
// (docs/01 §3.1 tick-5m), the other runs inside the backtest engine
// (docs/05 §3.2). They are kept in sync by a shared golden-vector fixture
// (packages/schema/fixtures/dsl-golden.json, docs/11 §4): if this file's
// behavior changes, that fixture (or a new vector added to it) must still
// pass in both languages.
//
// Deliberately data-structure-first, not object-oriented: the whole point
// of the DSL (docs/05 §9) is that evaluation has no side effects and no
// access to anything beyond the arrays passed in.

import type { BoolExpr } from "@cryptoedge/schema";

export interface DslEvent {
  type: string;
  magnitude: number;
}

export interface DslRegime {
  trend: "up" | "down" | "range";
  vol: "low" | "high" | "extreme";
  liquidity: "normal" | "stressed";
}

export interface DslEvalInput {
  /** epoch ms, ascending */
  timestamps: number[];
  /** feature_id -> value at each index; null = not available (e.g. insufficient history) */
  features: Record<string, (number | null)[]>;
  /** events concurrent with each index (usually 0 or 1 entries) */
  events: DslEvent[][];
  /** regime label at each index, or null if not yet computed */
  regimes: (DslRegime | null)[];
}

function featureValueAt(input: DslEvalInput, feature: string, lag: number, index: number): number | null {
  const series = input.features[feature];
  if (!series) return null;
  const i = index - lag;
  if (i < 0 || i >= series.length) return null;
  return series[i] ?? null;
}

function resolveOperand(
  input: DslEvalInput,
  operand: number | { feature: string; lag?: number | undefined },
  index: number
): number | null {
  if (typeof operand === "number") return operand;
  return featureValueAt(input, operand.feature, operand.lag ?? 0, index);
}

function utcHour(ts: number): number {
  return new Date(ts).getUTCHours();
}
function utcDow(ts: number): number {
  return new Date(ts).getUTCDay();
}

/**
 * Evaluates `expr` at a single index. Missing data (features out of range,
 * no regime computed yet) makes the containing comparison false rather
 * than throwing — a signal simply doesn't fire when its inputs aren't
 * ready, which is the conservative, look-ahead-safe default.
 */
export function evaluateAt(expr: BoolExpr, input: DslEvalInput, index: number): boolean {
  if ("and" in expr) return expr.and.every((e) => evaluateAt(e, input, index));
  if ("or" in expr) return expr.or.some((e) => evaluateAt(e, input, index));
  if ("not" in expr) return !evaluateAt(expr.not, input, index);

  if ("cmp" in expr) {
    const [left, op, right] = expr.cmp;
    const a = featureValueAt(input, left.feature, left.lag ?? 0, index);
    const b = resolveOperand(input, right, index);
    if (a === null || b === null) return false;
    switch (op) {
      case ">":
        return a > b;
      case "<":
        return a < b;
      case ">=":
        return a >= b;
      case "<=":
        return a <= b;
    }
  }

  if ("event" in expr) {
    const concurrent = input.events[index] ?? [];
    const threshold = expr.event.min_magnitude ?? Number.NEGATIVE_INFINITY;
    return concurrent.some((e) => e.type === expr.event.type && e.magnitude >= threshold);
  }

  if ("regime" in expr) {
    const regime = input.regimes[index];
    if (!regime) return false;
    if (expr.regime.trend && !expr.regime.trend.includes(regime.trend)) return false;
    if (expr.regime.vol && !expr.regime.vol.includes(regime.vol)) return false;
    if (expr.regime.liquidity && !expr.regime.liquidity.includes(regime.liquidity)) return false;
    return true;
  }

  if ("time" in expr) {
    const ts = input.timestamps[index];
    if (ts === undefined) return false;
    if (expr.time.utc_hour_in && !expr.time.utc_hour_in.includes(utcHour(ts))) return false;
    if (expr.time.dow_in && !expr.time.dow_in.includes(utcDow(ts))) return false;
    return true;
  }

  // Exhaustiveness is enforced by the BoolExpr union in packages/schema;
  // reaching here means the DSL was extended without updating this evaluator.
  throw new Error(`unhandled BoolExpr shape: ${JSON.stringify(expr)}`);
}

/** Evaluates `when` at every index, returning the fire series. */
export function computeFires(when: BoolExpr, input: DslEvalInput): boolean[] {
  return input.timestamps.map((_, i) => evaluateAt(when, input, i));
}
