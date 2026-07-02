"""Signal DSL evaluator (docs/05 §9).

Mirrors workers/ingest/src/signals/dsl-evaluator.ts exactly. The two are
kept in sync via a shared golden-vector fixture
(packages/schema/fixtures/dsl-golden.json, docs/11 §4) rather than one
importing the other — they run in different runtimes (Cloudflare Workers
vs. GitHub Actions) by design (docs/01 §1).

Deliberately dict/list based rather than pandas: this keeps the evaluator
a pure function over plain data, identical in shape to its TypeScript
twin, which is what makes the golden-vector contract meaningful. The
backtest engine (eval/backtest.py) is responsible for adapting a
DataFrame into this shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True)
class DslEvent:
    type: str
    magnitude: float


@dataclass(frozen=True)
class DslRegime:
    trend: str
    vol: str
    liquidity: str


@dataclass
class DslEvalInput:
    timestamps: list[int]
    features: dict[str, list[float | None]]
    events: list[list[DslEvent]] = field(default_factory=list)
    regimes: list[DslRegime | None] = field(default_factory=list)


BoolExpr = dict[str, Any]


class DslEvaluationError(Exception):
    """Raised when a BoolExpr shape isn't recognized (DSL extended without updating this evaluator)."""


def _feature_value_at(inp: DslEvalInput, feature: str, lag: int, index: int) -> float | None:
    series = inp.features.get(feature)
    if series is None:
        return None
    i = index - lag
    if i < 0 or i >= len(series):
        return None
    return series[i]


def _resolve_operand(inp: DslEvalInput, operand: float | dict[str, Any], index: int) -> float | None:
    if isinstance(operand, (int, float)):
        return float(operand)
    return _feature_value_at(inp, operand["feature"], operand.get("lag", 0), index)


def _utc_hour(ts_ms: int) -> int:
    return datetime.fromtimestamp(ts_ms / 1000, tz=UTC).hour


def _utc_dow(ts_ms: int) -> int:
    # Python's Monday=0..Sunday=6; JS's Sunday=0..Saturday=6 (docs/05 §9 dow_in
    # follows the JS/getUTCDay convention since the DSL originates from the TS
    # evaluator's fixture vectors) -> convert.
    py_dow = datetime.fromtimestamp(ts_ms / 1000, tz=UTC).weekday()  # Mon=0..Sun=6
    return (py_dow + 1) % 7  # Sun=0..Sat=6


def evaluate_at(expr: BoolExpr, inp: DslEvalInput, index: int) -> bool:
    """Evaluates `expr` at a single index. Missing data -> False (docs/05 §9: no look-ahead, no throw)."""
    if "and" in expr:
        return all(evaluate_at(e, inp, index) for e in expr["and"])
    if "or" in expr:
        return any(evaluate_at(e, inp, index) for e in expr["or"])
    if "not" in expr:
        return not evaluate_at(expr["not"], inp, index)

    if "cmp" in expr:
        left, op, right = expr["cmp"]
        a = _feature_value_at(inp, left["feature"], left.get("lag", 0), index)
        b = _resolve_operand(inp, right, index)
        if a is None or b is None:
            return False
        if op == ">":
            return a > b
        if op == "<":
            return a < b
        if op == ">=":
            return a >= b
        if op == "<=":
            return a <= b
        raise DslEvaluationError(f"unknown comparator: {op}")

    if "event" in expr:
        concurrent = inp.events[index] if index < len(inp.events) else []
        threshold = expr["event"].get("min_magnitude", float("-inf"))
        return any(e.type == expr["event"]["type"] and e.magnitude >= threshold for e in concurrent)

    if "regime" in expr:
        regime = inp.regimes[index] if index < len(inp.regimes) else None
        if regime is None:
            return False
        cond = expr["regime"]
        if "trend" in cond and regime.trend not in cond["trend"]:
            return False
        if "vol" in cond and regime.vol not in cond["vol"]:
            return False
        if "liquidity" in cond and regime.liquidity not in cond["liquidity"]:
            return False
        return True

    if "time" in expr:
        if index >= len(inp.timestamps):
            return False
        ts = inp.timestamps[index]
        cond = expr["time"]
        if "utc_hour_in" in cond and _utc_hour(ts) not in cond["utc_hour_in"]:
            return False
        if "dow_in" in cond and _utc_dow(ts) not in cond["dow_in"]:
            return False
        return True

    raise DslEvaluationError(f"unhandled BoolExpr shape: {expr!r}")


def compute_fires(when: BoolExpr, inp: DslEvalInput) -> list[bool]:
    """Evaluates `when` at every index, returning the fire series."""
    return [evaluate_at(when, inp, i) for i in range(len(inp.timestamps))]
