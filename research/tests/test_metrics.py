"""docs/11 §3.2: known-value cross-checks for the core metrics."""

import numpy as np
import pytest
from statsmodels.stats.proportion import proportion_confint

from cryptoedge_research.eval.metrics import (
    calmar_ratio,
    effective_n,
    ev_bps,
    max_drawdown,
    profit_factor,
    sharpe_ratio,
    sortino_ratio,
    top5_concentration,
    wilson_ci,
    win_rate,
)


def test_wilson_ci_matches_statsmodels_reference():
    lo, hi = wilson_ci(8, 10)
    ref_lo, ref_hi = proportion_confint(8, 10, alpha=0.05, method="wilson")
    assert lo == pytest.approx(ref_lo)
    assert hi == pytest.approx(ref_hi)
    assert 0.45 < lo < 0.55
    assert 0.90 < hi < 0.98


def test_win_rate_and_ci_bounds():
    returns = np.array([10, -5, 3, -1, 8, -2, 4, -3])
    rate, lo, hi = win_rate(returns)
    assert rate == pytest.approx(4 / 8)
    assert lo < rate < hi


def test_profit_factor_hand_computed():
    returns = np.array([10, 10, -5, -5])
    assert profit_factor(returns) == pytest.approx(20 / 10)


def test_profit_factor_no_losses_is_infinite():
    assert profit_factor(np.array([5, 5, 5])) == float("inf")


def test_sharpe_ratio_hand_computed():
    returns = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    mean = np.mean(returns)
    std = np.std(returns, ddof=1)
    expected = mean / std * np.sqrt(252)
    assert sharpe_ratio(returns, 252) == pytest.approx(expected)


def test_sharpe_ratio_zero_variance_is_zero_not_inf():
    assert sharpe_ratio(np.array([5.0, 5.0, 5.0]), 252) == 0.0


def test_sortino_ignores_upside_deviation():
    returns = np.array([100.0, 100.0, 100.0, -1.0])
    sortino = sortino_ratio(returns, 252)
    sharpe = sharpe_ratio(returns, 252)
    # Sortino only penalizes downside, so for a mostly-upside series it should exceed Sharpe.
    assert sortino > sharpe


def test_max_drawdown_known_sequence():
    # Equity path: 1 -> 1.10 -> 0.99 (from -10%) -> 1.089 (+10%)
    returns = np.array([1000.0, -1000.0, 1000.0])  # bps: +10%, -10%, +10%... approx
    dd = max_drawdown(returns)
    assert dd < 0  # some drawdown must be registered
    assert dd > -1  # never worse than total wipeout for these inputs


def test_max_drawdown_monotonic_gains_is_zero():
    assert max_drawdown(np.array([10.0, 20.0, 30.0])) == pytest.approx(0.0)


def test_calmar_ratio_zero_drawdown_is_zero():
    assert calmar_ratio(np.array([10.0, 20.0]), 252) == 0.0


def test_effective_n_iid_data_close_to_n():
    rng = np.random.default_rng(42)
    iid = rng.normal(0, 1, 500)
    n_eff = effective_n(iid)
    assert n_eff > 400  # should stay close to 500 for independent data


def test_effective_n_highly_autocorrelated_data_much_less_than_n():
    # Strongly positively autocorrelated series (each point ~ previous + small noise).
    rng = np.random.default_rng(1)
    n = 500
    x = np.zeros(n)
    for i in range(1, n):
        x[i] = 0.95 * x[i - 1] + rng.normal(0, 0.1)
    n_eff = effective_n(x)
    assert n_eff < 100  # heavy autocorrelation should shrink n_eff a lot


def test_top5_concentration_single_trade_dominates():
    returns = np.array([1000.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    conc = top5_concentration(returns)
    assert conc > 0.9


def test_ev_bps_empty_is_zero():
    assert ev_bps(np.array([])) == 0.0
