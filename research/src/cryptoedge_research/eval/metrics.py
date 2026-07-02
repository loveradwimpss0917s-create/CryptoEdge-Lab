"""Core performance metrics (docs/05 §4). Every full/screen run computes
these per segment (overall, wf:oos, wf:fold{n}, regime:*, year:*,
cost:zero) and stores them in `eval_metrics` via the internal client.

Inputs are always trade-level returns in basis points (bps), net of cost
unless explicitly labeled a `cost:zero` segment (docs/00 §3 principle 4:
cost is always in unless labeled otherwise).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from statsmodels.stats.proportion import proportion_confint


def wilson_ci(successes: int, n: int, confidence: float = 0.95) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion (docs/05 §3.6: exact, small-sample safe).

    Delegates to statsmodels' battle-tested implementation rather than a
    hand-rolled formula — see tests for cross-checks against known values.
    """
    if n == 0:
        return (0.0, 0.0)
    lo, hi = proportion_confint(successes, n, alpha=1 - confidence, method="wilson")
    return (float(lo), float(hi))


def win_rate(returns_bps: np.ndarray) -> tuple[float, float, float]:
    """Returns (win_rate, ci_lo, ci_hi) using Wilson CI on wins/total."""
    n = len(returns_bps)
    if n == 0:
        return (0.0, 0.0, 0.0)
    wins = int(np.sum(returns_bps > 0))
    lo, hi = wilson_ci(wins, n)
    return (wins / n, lo, hi)


def profit_factor(returns_bps: np.ndarray) -> float:
    gains = returns_bps[returns_bps > 0].sum()
    losses = -returns_bps[returns_bps < 0].sum()
    if losses == 0:
        return float("inf") if gains > 0 else 0.0
    return float(gains / losses)


def sharpe_ratio(returns_bps: np.ndarray, trades_per_year: float) -> float:
    """Annualized Sharpe from trade-level returns (docs/05 §4: 'シグナルベース戦略は
    保有期間リターンから年率換算'). Requires >= 2 trades for a defined sample std."""
    if len(returns_bps) < 2:
        return 0.0
    mean = np.mean(returns_bps)
    std = np.std(returns_bps, ddof=1)
    if std == 0:
        return 0.0
    return float(mean / std * np.sqrt(trades_per_year))


def sortino_ratio(returns_bps: np.ndarray, trades_per_year: float) -> float:
    if len(returns_bps) < 2:
        return 0.0
    mean = np.mean(returns_bps)
    downside = returns_bps[returns_bps < 0]
    if len(downside) == 0:
        return float("inf") if mean > 0 else 0.0
    downside_dev = np.sqrt(np.mean(downside**2))
    if downside_dev == 0:
        return 0.0
    return float(mean / downside_dev * np.sqrt(trades_per_year))


def equity_curve(returns_bps: np.ndarray) -> np.ndarray:
    """Multiplicative equity curve starting at 1.0, from trade returns in bps."""
    return np.cumprod(1.0 + returns_bps / 10_000.0)


def max_drawdown(returns_bps: np.ndarray) -> float:
    """Maximum fractional drawdown (negative number, e.g. -0.22 = -22%)."""
    if len(returns_bps) == 0:
        return 0.0
    curve = equity_curve(returns_bps)
    running_max = np.maximum.accumulate(curve)
    drawdown = (curve - running_max) / running_max
    return float(np.min(drawdown))


def calmar_ratio(returns_bps: np.ndarray, trades_per_year: float) -> float:
    mdd = max_drawdown(returns_bps)
    if mdd == 0:
        return 0.0
    annualized_return = float(np.mean(returns_bps)) / 10_000.0 * trades_per_year
    return annualized_return / abs(mdd)


def effective_n(returns_bps: np.ndarray) -> float:
    """n_eff = n(1-rho)/(1+rho) using lag-1 autocorrelation (docs/05 §3.6:
    'シグナル重複・自己相関補正'). Clipped to [1, n]."""
    n = len(returns_bps)
    if n < 3:
        return float(n)
    x = returns_bps - np.mean(returns_bps)
    denom = np.sum(x[:-1] ** 2)
    if denom == 0:
        return float(n)
    rho = float(np.sum(x[:-1] * x[1:]) / denom)
    rho = max(min(rho, 0.999), -0.999)
    n_eff = n * (1 - rho) / (1 + rho)
    return float(np.clip(n_eff, 1.0, n))


def ev_bps(returns_bps: np.ndarray) -> float:
    return float(np.mean(returns_bps)) if len(returns_bps) > 0 else 0.0


def top5_concentration(returns_bps: np.ndarray) -> float:
    """Share of total positive P&L contributed by the 5 largest winning trades
    (docs/05 §3.8: guards against a single outlier event driving the whole result)."""
    gains = returns_bps[returns_bps > 0]
    total = gains.sum()
    if total <= 0:
        return 0.0
    top5 = np.sort(gains)[-5:].sum()
    return float(top5 / total)


def fold_consistency(fold_ev_bps: list[float]) -> float:
    """Share of walk-forward folds with a positive EV (docs/05 §3.4)."""
    if not fold_ev_bps:
        return 0.0
    return float(sum(1 for e in fold_ev_bps if e > 0) / len(fold_ev_bps))


@dataclass(frozen=True)
class MetricBundle:
    ev_bps: float
    win_rate: float
    win_rate_ci_lo: float
    win_rate_ci_hi: float
    pf: float
    sharpe: float
    sortino: float
    calmar: float
    max_dd: float
    n_trades: int
    n_eff: float
    top5_concentration: float


def compute_bundle(returns_bps: np.ndarray, trades_per_year: float) -> MetricBundle:
    wr, wr_lo, wr_hi = win_rate(returns_bps)
    return MetricBundle(
        ev_bps=ev_bps(returns_bps),
        win_rate=wr,
        win_rate_ci_lo=wr_lo,
        win_rate_ci_hi=wr_hi,
        pf=profit_factor(returns_bps),
        sharpe=sharpe_ratio(returns_bps, trades_per_year),
        sortino=sortino_ratio(returns_bps, trades_per_year),
        calmar=calmar_ratio(returns_bps, trades_per_year),
        max_dd=max_drawdown(returns_bps),
        n_trades=len(returns_bps),
        n_eff=effective_n(returns_bps),
        top5_concentration=top5_concentration(returns_bps),
    )
