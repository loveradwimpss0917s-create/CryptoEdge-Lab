"""Full Edge Evaluation Protocol orchestration (docs/05 §3): wires
backtest -> walk-forward -> permutation -> bootstrap -> DSR -> verdict
into one call producing exactly the segment/metric rows `eval_metrics`
expects (docs/02 §2.5) plus a `verdicts` row (docs/08 `/internal/runs/*`).

This is EEP protocol_version "1.0" (docs/05 §1).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np

from cryptoedge_research.dsl.evaluator import DslRegime
from cryptoedge_research.eval.backtest import Trade
from cryptoedge_research.eval.bootstrap import bootstrap_ci
from cryptoedge_research.eval.dsr import deflated_sharpe_ratio
from cryptoedge_research.eval.metrics import (
    compute_bundle,
    ev_bps,
    max_drawdown,
    sharpe_ratio,
    top5_concentration,
)
from cryptoedge_research.eval.permutation import permutation_test
from cryptoedge_research.eval.verdict import VerdictInputs, VerdictOutcome, VerdictThresholds, decide_verdict
from cryptoedge_research.eval.walk_forward import anchored_walk_forward_splits

PROTOCOL_VERSION = "1.0"


@dataclass(frozen=True)
class EepConfig:
    n_folds: int = 5
    # Walk-forward purge/embargo margin, in wall-clock ms (docs/05 §3.4;
    # 2026-07 review finding H-3: this used to be `purge_trades`, a bar-count
    # that didn't account for a trade's actual holding period).
    embargo_ms: int = 5 * 86_400_000
    permutation_iterations: int = 1000
    bootstrap_iterations: int = 2000
    bootstrap_confidence: float = 0.95
    seed: int = 0
    # None = derive from the actual trade timestamps (docs/05 §4: "シグナル
    # ベース戦略は保有期間リターンから年率換算" — a fixed 252 assumed every
    # Edge trades daily, which silently mis-annualizes Sharpe for anything
    # higher/lower frequency; 2026-07 review finding H-1). Set explicitly
    # only for tests wanting a deterministic annualization factor.
    trades_per_year: float | None = None
    recent_years: int = 2


# docs/05 §2's state table: "CANDIDATE→TESTING | screen run (簡易EEP) で
# ev_bps > 0 かつ p_perm < 0.20" -- a screen run only ever needs to move
# those two `overall`-segment numbers, unlike a full run's ADOPT decision
# (docs/05 §2 "TESTING→VALIDATED | full run の verdict = ADOPT"), which
# reads the bootstrap-CI'd wf:oos metrics `decide_verdict` gates on. Before
# this (2026-07 design audit TASK-5), on_demand.py never passed a
# `run_kind`-specific config at all, so a "screen" run cost exactly as much
# compute as a "full" one -- the opposite of what "簡易" (simplified) means,
# and the actual bottleneck for bulk-screening the ~50 unseeded seed Edges.
SCREEN_EEP_CONFIG = EepConfig(n_folds=3, permutation_iterations=200, bootstrap_iterations=300)
FULL_EEP_CONFIG = EepConfig()


def eep_config_for_run_kind(run_kind: str) -> EepConfig:
    """Only an exact `"screen"` gets the cheaper config -- `"full"` and
    anything else (`"incremental"`, `"decay_check"`) default to full rigor
    defensively, since those gate ACTIVE/PAPER transitions and a decay
    check silently running under-powered would be worse than one running
    slower than necessary."""
    return SCREEN_EEP_CONFIG if run_kind == "screen" else FULL_EEP_CONFIG


_MIN_SPAN_YEARS = 1.0 / 365.0  # floor at one day, so a same-timestamp trade set can't blow up to infinity


def _actual_trades_per_year(trades: list[Trade]) -> float:
    if len(trades) < 2:
        return 252.0  # arbitrary — sharpe_ratio() already returns 0 for <2 trades regardless
    span_ms = max(t.entry_ts for t in trades) - min(t.entry_ts for t in trades)
    span_years = max(span_ms / 86_400_000 / 365.0, _MIN_SPAN_YEARS)
    return len(trades) / span_years


@dataclass(frozen=True)
class MetricRow:
    segment: str
    metric: str
    value: float
    ci_lo: float | None = None
    ci_hi: float | None = None


@dataclass(frozen=True)
class EepResult:
    metrics: list[MetricRow]
    verdict: VerdictOutcome


def _regime_label(r: DslRegime | None) -> str:
    if r is None:
        return "unknown"
    return f"{r.trend}_{r.vol}_{r.liquidity}"


def run_eep(
    trades: list[Trade],
    forward_returns_bps: np.ndarray,
    fires: list[bool],
    horizon_bars: int,
    regimes: list[DslRegime | None],
    n_trials: int,
    config: EepConfig | None = None,
    thresholds: VerdictThresholds | None = None,
) -> EepResult:
    config = config or EepConfig()
    thresholds = thresholds or VerdictThresholds()
    metrics: list[MetricRow] = []

    gross_returns = np.array([t.ret_bps for t in trades])
    net_returns = np.array([t.ret_net_bps for t in trades])

    if len(net_returns) == 0:
        empty_inputs = VerdictInputs(0, 0, 0, 0, 1, 0, 0, 0, 0, 0, None, None)
        return EepResult(
            metrics=[MetricRow("overall", "trades", 0)],
            verdict=decide_verdict(empty_inputs, thresholds),
        )

    trades_per_year = (
        config.trades_per_year if config.trades_per_year is not None else _actual_trades_per_year(trades)
    )
    metrics.append(MetricRow("overall", "trades_per_year", trades_per_year))

    overall = compute_bundle(net_returns, trades_per_year)
    metrics += _bundle_rows("overall", overall)
    metrics.append(MetricRow("cost:zero", "ev_bps", ev_bps(gross_returns)))

    # --- Walk-forward (docs/05 §3.4) ---
    # A fold needs >=1 sample on each side of the split, so n_folds is capped
    # by the trade count; below that there simply isn't enough data for any
    # OOS split; docs/05 §5's n_eff>=30 ADOPT gate will reject such runs
    # anyway; this just keeps the pipeline from crashing on sparse Edges.
    # `anchored_walk_forward_splits` can also raise if every trade shares the
    # same entry_ts (zero time span to split) — equally "not enough data",
    # so it's treated the same as too few trades.
    effective_n_folds = min(config.n_folds, len(net_returns) - 1)
    fold_evs: list[float] = []
    oos_idx: list[int] = []
    if effective_n_folds >= 1:
        try:
            folds = anchored_walk_forward_splits(
                trades, n_folds=effective_n_folds, embargo_ms=config.embargo_ms
            )
        except ValueError:
            folds = []
        for fold in folds:
            test_returns = net_returns[fold.test_idx]
            fold_ev = ev_bps(test_returns)
            fold_evs.append(fold_ev)
            oos_idx.extend(fold.test_idx)
            metrics.append(MetricRow(f"wf:fold{fold.fold_index}", "ev_bps", fold_ev))
            metrics.append(MetricRow(f"wf:fold{fold.fold_index}", "trades", len(fold.test_idx)))

    fold_consistency_value = (
        sum(1 for e in fold_evs if e > 0) / len(fold_evs) if fold_evs else 0.0
    )
    oos_returns = net_returns[sorted(set(oos_idx))] if oos_idx else net_returns
    wf_oos = compute_bundle(oos_returns, trades_per_year)
    metrics += _bundle_rows("wf:oos", wf_oos)
    metrics.append(MetricRow("wf:oos", "fold_consistency", fold_consistency_value))

    # --- Permutation test (docs/05 §3.5) ---
    perm = permutation_test(
        forward_returns_bps,
        np.array(fires, dtype=bool),
        horizon_bars,
        n_iterations=config.permutation_iterations,
        seed=config.seed,
    )
    metrics.append(MetricRow("wf:oos", "p_perm", perm.p_value))

    # --- Bootstrap CIs (docs/05 §3.6), computed on the OOS sample ---
    avg_block_len = max(1, horizon_bars * 3)
    ev_boot = bootstrap_ci(
        oos_returns,
        ev_bps,
        avg_block_len,
        config.bootstrap_iterations,
        config.bootstrap_confidence,
        config.seed,
    )
    sharpe_boot = bootstrap_ci(
        oos_returns,
        lambda r: sharpe_ratio(r, trades_per_year),
        avg_block_len,
        config.bootstrap_iterations,
        config.bootstrap_confidence,
        config.seed + 1,
    )
    maxdd_boot = bootstrap_ci(
        oos_returns,
        max_drawdown,
        avg_block_len,
        config.bootstrap_iterations,
        config.bootstrap_confidence,
        config.seed + 2,
    )
    metrics.append(
        MetricRow("wf:oos", "ev_bps_bootstrap", ev_boot.point_estimate, ev_boot.ci_lo, ev_boot.ci_hi)
    )
    metrics.append(
        MetricRow(
            "wf:oos", "sharpe_bootstrap", sharpe_boot.point_estimate, sharpe_boot.ci_lo, sharpe_boot.ci_hi
        )
    )
    metrics.append(
        MetricRow("wf:oos", "max_dd_bootstrap", maxdd_boot.point_estimate, maxdd_boot.ci_lo, maxdd_boot.ci_hi)
    )

    # --- Deflated Sharpe Ratio (docs/05 §3.7) ---
    dsr_value = deflated_sharpe_ratio(oos_returns, n_trials)
    metrics.append(MetricRow("wf:oos", "dsr", dsr_value))

    # --- Regime segmentation (docs/05 §3.8) ---
    by_regime: dict[str, list[float]] = defaultdict(list)
    for trade in trades:
        label = _regime_label(regimes[trade.signal_index] if trade.signal_index < len(regimes) else None)
        by_regime[label].append(trade.ret_net_bps)
    regime_evs: dict[str, float] = {}
    for label, rets in by_regime.items():
        arr = np.array(rets)
        regime_ev = ev_bps(arr)
        regime_evs[label] = regime_ev
        metrics.append(MetricRow(f"regime:{label}", "ev_bps", regime_ev))
        metrics.append(MetricRow(f"regime:{label}", "trades", len(arr)))
    regime_worst_ev = min(regime_evs.values()) if regime_evs else overall.ev_bps

    # --- Year segmentation + recent-years REJECT check (docs/05 §3.8, §5) ---
    by_year: dict[int, list[float]] = defaultdict(list)
    for trade in trades:
        year = datetime.fromtimestamp(trade.entry_ts / 1000, tz=UTC).year
        by_year[year].append(trade.ret_net_bps)
    for year, rets in sorted(by_year.items()):
        metrics.append(MetricRow(f"year:{year}", "ev_bps", ev_bps(np.array(rets))))

    latest_ts = max(t.entry_ts for t in trades)
    cutoff_ts = latest_ts - config.recent_years * 365 * 86_400_000
    recent_returns = np.array([t.ret_net_bps for t in trades if t.entry_ts >= cutoff_ts])
    recent_2y_ev = ev_bps(recent_returns) if len(recent_returns) > 0 else None
    if recent_2y_ev is not None:
        metrics.append(MetricRow(f"year:recent{config.recent_years}y", "ev_bps", recent_2y_ev))

    top5 = top5_concentration(oos_returns)
    metrics.append(MetricRow("wf:oos", "top5_concentration", top5))

    verdict_inputs = VerdictInputs(
        ev_bps_ci_lo=ev_boot.ci_lo,
        ev_bps_ci_hi=ev_boot.ci_hi,
        sharpe=wf_oos.sharpe,
        dsr=dsr_value,
        p_perm=perm.p_value,
        n_eff=wf_oos.n_eff,
        fold_consistency=fold_consistency_value,
        regime_worst_ev_bps=regime_worst_ev,
        ev_bps=wf_oos.ev_bps,
        top5_concentration=top5,
        corr_max_active=None,  # docs/05 §8 — wired at the portfolio-correlation layer, not per-run
        recent_2y_ev_bps=recent_2y_ev,
    )
    verdict = decide_verdict(verdict_inputs, thresholds)

    return EepResult(metrics=metrics, verdict=verdict)


def _bundle_rows(segment: str, bundle) -> list[MetricRow]:  # noqa: ANN001 - MetricBundle, avoids import cycle noise
    return [
        MetricRow(segment, "ev_bps", bundle.ev_bps),
        MetricRow(segment, "win_rate", bundle.win_rate, bundle.win_rate_ci_lo, bundle.win_rate_ci_hi),
        MetricRow(segment, "pf", bundle.pf),
        MetricRow(segment, "sharpe", bundle.sharpe),
        MetricRow(segment, "sortino", bundle.sortino),
        MetricRow(segment, "calmar", bundle.calmar),
        MetricRow(segment, "max_dd", bundle.max_dd),
        MetricRow(segment, "trades", bundle.n_trades),
        MetricRow(segment, "n_eff", bundle.n_eff),
    ]
