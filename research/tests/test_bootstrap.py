import numpy as np

from cryptoedge_research.eval.bootstrap import bootstrap_ci, stationary_bootstrap_indices
from cryptoedge_research.eval.metrics import ev_bps


def test_stationary_bootstrap_indices_stay_in_range():
    rng = np.random.default_rng(0)
    idx = stationary_bootstrap_indices(100, avg_block_len=10, rng=rng)
    assert len(idx) == 100
    assert idx.min() >= 0
    assert idx.max() < 100


def test_bootstrap_ci_contains_point_estimate():
    rng = np.random.default_rng(3)
    returns = rng.normal(15, 20, 300)
    result = bootstrap_ci(returns, ev_bps, avg_block_len=5, n_iterations=500, seed=1)
    assert result.ci_lo <= result.point_estimate <= result.ci_hi


def test_bootstrap_ci_narrows_with_more_data():
    rng = np.random.default_rng(4)
    small = rng.normal(15, 20, 50)
    large = rng.normal(15, 20, 1000)
    small_ci = bootstrap_ci(small, ev_bps, avg_block_len=3, n_iterations=1000, seed=2)
    large_ci = bootstrap_ci(large, ev_bps, avg_block_len=3, n_iterations=1000, seed=2)
    assert (large_ci.ci_hi - large_ci.ci_lo) < (small_ci.ci_hi - small_ci.ci_lo)


def test_bootstrap_ci_degenerate_for_tiny_sample():
    result = bootstrap_ci(np.array([5.0]), ev_bps, avg_block_len=3, n_iterations=100, seed=0)
    assert result.ci_lo == result.ci_hi == result.point_estimate == 5.0
