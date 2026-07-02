"""Stationary bootstrap confidence intervals (docs/05 §3.6).

Politis & Romano (1994) stationary bootstrap: resamples blocks of
geometrically-distributed random length (mean = `avg_block_len`) with
wraparound, which — unlike a fixed block length — produces a stationary
resampled series and avoids edge artifacts at block boundaries.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np


def stationary_bootstrap_indices(n: int, avg_block_len: float, rng: np.random.Generator) -> np.ndarray:
    if n == 0:
        return np.array([], dtype=int)
    p = 1.0 / max(avg_block_len, 1.0)
    indices = np.empty(n, dtype=int)
    idx = int(rng.integers(0, n))
    for t in range(n):
        indices[t] = idx
        idx = int(rng.integers(0, n)) if rng.random() < p else (idx + 1) % n
    return indices


@dataclass(frozen=True)
class BootstrapCi:
    point_estimate: float
    ci_lo: float
    ci_hi: float
    n_iterations: int


def bootstrap_ci(
    returns_bps: np.ndarray,
    statistic_fn: Callable[[np.ndarray], float],
    avg_block_len: float,
    n_iterations: int = 2000,
    confidence: float = 0.95,
    seed: int = 0,
) -> BootstrapCi:
    """Percentile-method CI for `statistic_fn(returns_bps)` via stationary bootstrap."""
    returns_bps = np.asarray(returns_bps, dtype=float)
    n = len(returns_bps)
    point = statistic_fn(returns_bps) if n > 0 else 0.0
    if n < 2:
        return BootstrapCi(point, point, point, n_iterations)

    rng = np.random.default_rng(seed)
    draws = np.empty(n_iterations)
    for i in range(n_iterations):
        idx = stationary_bootstrap_indices(n, avg_block_len, rng)
        draws[i] = statistic_fn(returns_bps[idx])

    alpha = 1 - confidence
    lo, hi = np.quantile(draws, [alpha / 2, 1 - alpha / 2])
    return BootstrapCi(point_estimate=point, ci_lo=float(lo), ci_hi=float(hi), n_iterations=n_iterations)
