"""docs/11 §3.5 + docs/00 §2.2 W1: DSR must actually penalize multiple testing —
this is the test that guards against the PDF's core statistical weakness
silently regressing."""

import numpy as np

from cryptoedge_research.eval.dsr import deflated_sharpe_ratio, probabilistic_sharpe_ratio


def _strong_signal(seed: int, n: int = 300) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.normal(15, 20, n)  # consistent positive mean, moderate noise


def _pure_noise(seed: int, n: int = 300) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.normal(0, 20, n)


def test_dsr_decreases_as_trial_count_increases():
    returns = _strong_signal(1)
    dsr_1 = deflated_sharpe_ratio(returns, n_trials=1)
    dsr_10 = deflated_sharpe_ratio(returns, n_trials=10)
    dsr_100 = deflated_sharpe_ratio(returns, n_trials=100)
    assert dsr_1 >= dsr_10 >= dsr_100


def test_strong_signal_survives_modest_trial_count():
    returns = _strong_signal(2)
    assert deflated_sharpe_ratio(returns, n_trials=5) > 0.9


def test_pure_noise_fails_even_at_a_single_trial_on_average():
    # Not every noise draw has PSR(0) near 0.5, but averaged over many seeds
    # it should hover near 0.5 (i.e. "as likely negative as positive"),
    # nowhere near the 0.90 ADOPT bar.
    values = [probabilistic_sharpe_ratio(_pure_noise(seed)) for seed in range(30)]
    assert 0.3 < float(np.mean(values)) < 0.7


def test_psr_of_deterministic_positive_series_approaches_one():
    # No noise at all beyond floating point -> essentially infinite Sharpe.
    returns = np.array([10.0] * 50) + np.linspace(0, 1e-6, 50)
    assert probabilistic_sharpe_ratio(returns) > 0.99


def test_dsr_below_adopt_threshold_for_marginal_signal_with_many_trials():
    # A modest, noisy edge that would look OK on one test but shouldn't
    # clear the ADOPT bar after being "found" via many trials.
    rng = np.random.default_rng(5)
    returns = rng.normal(3, 20, 100)
    assert deflated_sharpe_ratio(returns, n_trials=50) < 0.90
