"""docs/11 §3.5: permutation test must have real detection power on an
embedded effect and must NOT falsely reject the null on pure noise."""

import numpy as np

from cryptoedge_research.eval.permutation import permutation_test


def test_strong_embedded_effect_yields_small_p_value():
    rng = np.random.default_rng(7)
    n = 2000
    forward_returns = rng.normal(0, 20, n)  # baseline noise, mean 0, sd 20bps
    fires = np.zeros(n, dtype=bool)
    # Plant a genuine, elevated-mean signal at ~10% of bars.
    signal_positions = rng.choice(n, size=n // 10, replace=False)
    fires[signal_positions] = True
    forward_returns[signal_positions] += 40  # true edge: +40bps on average when fired

    result = permutation_test(forward_returns, fires, horizon_bars=1, n_iterations=500, seed=1)
    assert result.observed_ev_bps > 30
    assert result.p_value < 0.05


def test_pure_noise_signal_yields_large_p_value():
    rng = np.random.default_rng(11)
    n = 2000
    forward_returns = rng.normal(0, 20, n)
    # Fire completely at random, uncorrelated with returns -> no real edge.
    fires = rng.random(n) < 0.1

    result = permutation_test(forward_returns, fires, horizon_bars=1, n_iterations=500, seed=2)
    assert result.p_value > 0.10


def test_no_fires_returns_degenerate_but_safe_result():
    forward_returns = np.zeros(100)
    fires = np.zeros(100, dtype=bool)
    result = permutation_test(forward_returns, fires, horizon_bars=1, n_iterations=100, seed=0)
    assert result.observed_ev_bps == 0.0
    assert result.p_value == 1.0
