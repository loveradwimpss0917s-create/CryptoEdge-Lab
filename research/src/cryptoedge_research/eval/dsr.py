"""Deflated & Probabilistic Sharpe Ratio (docs/05 §3.7, Bailey & López de
Prado 2014 "The Deflated Sharpe Ratio").

This is the direct answer to PDF weakness W1 (docs/00 §2.2): a Sharpe
ratio computed after trying many variations is inflated in expectation.
DSR asks "what is the probability the *true* Sharpe is positive, given
that this is the best of `n_trials` attempts?" — using the number of
prior screen/full runs against this Edge (docs/02 `eval_runs` is the
Trial Registry) as `n_trials`.
"""

from __future__ import annotations

import numpy as np
from scipy.stats import kurtosis as _kurtosis
from scipy.stats import norm
from scipy.stats import skew as _skew

EULER_MASCHERONI = 0.5772156649015329


def _sample_stats(returns: np.ndarray) -> tuple[float, float, float, int]:
    n = len(returns)
    mean = float(np.mean(returns))
    std = float(np.std(returns, ddof=1)) if n > 1 else 0.0
    sr_hat = mean / std if std > 0 else 0.0
    skewness = float(_skew(returns)) if n > 2 else 0.0
    # fisher=False -> Pearson (non-excess) kurtosis, normal distribution = 3.
    kurt = float(_kurtosis(returns, fisher=False)) if n > 3 else 3.0
    return sr_hat, skewness, kurt, n


def _psr_from_stats(sr_hat: float, sr_benchmark: float, skewness: float, kurt: float, n: int) -> float:
    if n < 3:
        return 0.0
    denom = 1 - skewness * sr_hat + ((kurt - 1) / 4) * sr_hat**2
    denom = max(denom, 1e-12)
    z = (sr_hat - sr_benchmark) * np.sqrt(n - 1) / np.sqrt(denom)
    return float(norm.cdf(z))


def probabilistic_sharpe_ratio(returns_bps: np.ndarray, sr_benchmark: float = 0.0) -> float:
    """PSR(SR*): probability the true (per-trade, non-annualized) Sharpe exceeds `sr_benchmark`."""
    sr_hat, skewness, kurt, n = _sample_stats(np.asarray(returns_bps, dtype=float))
    return _psr_from_stats(sr_hat, sr_benchmark, skewness, kurt, n)


def expected_max_sharpe(n_trials: int, sr_hat: float, skewness: float, kurt: float, n: int) -> float:
    """E[max SR] across `n_trials` independent trials under the null of zero true skill
    (the 'deflation' benchmark) — Bailey & López de Prado eq. 8."""
    if n_trials <= 1 or n < 3:
        return 0.0
    denom = 1 - skewness * sr_hat + ((kurt - 1) / 4) * sr_hat**2
    var_sr = max(denom, 1e-12) / (n - 1)
    sigma_sr = np.sqrt(var_sr)
    z1 = norm.ppf(1 - 1 / n_trials)
    z2 = norm.ppf(1 - 1 / (n_trials * np.e))
    return float(sigma_sr * ((1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2))


def deflated_sharpe_ratio(returns_bps: np.ndarray, n_trials: int) -> float:
    """DSR = P(true SR > 0 | best of n_trials attempts). n_trials should include
    this run (docs/05 §3.7: cumulative screen+full run count against the edge,
    including Discovery's batch trial-space size when the edge originated there)."""
    returns_bps = np.asarray(returns_bps, dtype=float)
    sr_hat, skewness, kurt, n = _sample_stats(returns_bps)
    if n < 3:
        return 0.0
    sr0 = expected_max_sharpe(max(n_trials, 1), sr_hat, skewness, kurt, n)
    return _psr_from_stats(sr_hat, sr0, skewness, kurt, n)
