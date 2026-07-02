"""Backtest execution engine (docs/05 §3.2-3.3).

Turns a `signal_spec` (docs/05 §9 DSL) plus a price series into a trade
list, applying the project-wide execution and cost conventions:

- Entry is always the *next bar's open* after the signal fires
  (`entry.delay_bars`, default 1) — same-bar close execution is banned
  project-wide as a look-ahead bug (docs/00 §3 principle 2).
- Cost is a round-trip taker + slippage charge from `edge_versions.cost_model`
  (docs/00 §3 principle 4: nothing is shown cost-free except explicitly
  labeled `cost:zero` reference segments).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from cryptoedge_research.dsl.evaluator import DslEvalInput, compute_fires

_HORIZON_RE = re.compile(r"^(\d+)(m|h|d)$")
_UNIT_MS = {"m": 60_000, "h": 3_600_000, "d": 86_400_000}


def parse_horizon_bars(horizon: str, bar_interval_ms: int) -> int:
    """Converts a horizon string like '30m', '72h', '24h' (docs/05 §9) into a
    bar count for the series' actual bar interval. Rounds up so the holding
    period is never shorter than requested."""
    match = _HORIZON_RE.match(horizon.strip())
    if not match:
        raise ValueError(f"unsupported horizon format: {horizon!r}")
    amount, unit = match.groups()
    horizon_ms = int(amount) * _UNIT_MS[unit]
    return max(1, -(-horizon_ms // bar_interval_ms))  # ceil division


@dataclass(frozen=True)
class CostModel:
    taker_bps: float
    slippage_bps: float

    @property
    def round_trip_bps(self) -> float:
        return (self.taker_bps + self.slippage_bps) * 2


@dataclass(frozen=True)
class Trade:
    signal_index: int
    entry_index: int
    exit_index: int
    entry_ts: int
    exit_ts: int
    direction: str
    ret_bps: float
    ret_net_bps: float


def run_backtest(
    when: dict,
    direction: str,
    horizon: str,
    cost_model: CostModel,
    timestamps: list[int],
    opens: np.ndarray,
    closes: np.ndarray,
    bar_interval_ms: int,
    dsl_input: DslEvalInput,
    entry_delay_bars: int = 1,
) -> list[Trade]:
    """Runs the DSL signal against `opens`/`closes` and returns the realized trades.

    `dsl_input` carries the feature/event/regime arrays the signal condition
    reads; `opens`/`closes` are the execution price series and may differ in
    length source from the feature arrays only if the caller has already
    aligned them — this function assumes all arrays share the same index.
    """
    if direction not in ("long", "short"):
        raise NotImplementedError(
            f"direction={direction!r} is not yet supported by the backtest engine "
            "(signal_sign requires wiring an indicator-sign source; see docs/05 §9)"
        )

    fires = compute_fires(when, dsl_input)
    horizon_bars = parse_horizon_bars(horizon, bar_interval_ms)
    n = len(timestamps)
    trades: list[Trade] = []

    for i, fired in enumerate(fires):
        if not fired:
            continue
        entry_idx = i + entry_delay_bars
        exit_idx = entry_idx + horizon_bars
        if exit_idx >= n:
            continue  # not enough forward data to realize this trade — skip, don't fabricate
        entry_px = opens[entry_idx]
        exit_px = closes[exit_idx]
        if direction == "long":
            ret_bps = (exit_px / entry_px - 1.0) * 10_000
        else:
            ret_bps = (entry_px / exit_px - 1.0) * 10_000
        ret_net_bps = ret_bps - cost_model.round_trip_bps
        trades.append(
            Trade(
                signal_index=i,
                entry_index=entry_idx,
                exit_index=exit_idx,
                entry_ts=timestamps[entry_idx],
                exit_ts=timestamps[exit_idx],
                direction=direction,
                ret_bps=ret_bps,
                ret_net_bps=ret_net_bps,
            )
        )
    return trades


def forward_returns_series(
    opens: np.ndarray, closes: np.ndarray, entry_delay_bars: int, horizon_bars: int, direction: str
) -> np.ndarray:
    """The return every bar *would* realize if a trade opened there — used by
    permutation.py, which needs a full-length series, not just fired trades."""
    n = len(opens)
    out = np.full(n, np.nan)
    for i in range(n):
        entry_idx = i + entry_delay_bars
        exit_idx = entry_idx + horizon_bars
        if exit_idx >= n:
            continue
        entry_px = opens[entry_idx]
        exit_px = closes[exit_idx]
        if direction == "long":
            out[i] = (exit_px / entry_px - 1.0) * 10_000
        else:
            out[i] = (entry_px / exit_px - 1.0) * 10_000
    return out
