"""docs/11 §3.1: the golden-dataset test. EEP must (a) ADOPT an Edge with
a real, embedded effect and (b) NOT ADOPT a random-noise "Edge" — this is
the single most important test in the whole platform, since a silently
broken EEP would rubber-stamp everything (docs/10 R-J1)."""

import numpy as np
import pytest

from cryptoedge_research.dsl.evaluator import DslEvalInput, compute_fires
from cryptoedge_research.eval.backtest import CostModel, forward_returns_series, run_backtest
from cryptoedge_research.eval.pipeline import (
    FULL_EEP_CONFIG,
    SCREEN_EEP_CONFIG,
    EepConfig,
    eep_config_for_run_kind,
    run_eep,
)

BAR_MS = 3_600_000  # 1h bars
WHEN = {"cmp": [{"feature": "flag"}, ">", 0.5]}
FAST_CONFIG = EepConfig(n_folds=5, permutation_iterations=300, bootstrap_iterations=500, seed=42)


def _build_series(n: int, embed_effect_bps: float, seed: int) -> tuple[np.ndarray, np.ndarray, DslEvalInput]:
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 25, n)  # ~25bps hourly noise, roughly BTC-scale
    flag = (rng.random(n) < 0.08).astype(float)  # fires ~8% of bars

    log_returns = noise / 10_000.0
    # Entry is at bar i+1 (next-bar-open, entry_delay_bars=1) and exit is at
    # bar i+2 (1h horizon = 1 bar later); the realized trade return is driven
    # by log_returns[i+2] (price[i+2] relative to price[i+1]), so that's
    # where the embedded effect belongs.
    for i in range(n - 2):
        if flag[i] > 0.5:
            log_returns[i + 2] += embed_effect_bps / 10_000.0

    log_prices = np.cumsum(log_returns) + np.log(100.0)
    prices = np.exp(log_prices)
    opens = prices.copy()
    closes = prices.copy()

    dsl_input = DslEvalInput(
        timestamps=[i * BAR_MS for i in range(n)],
        features={"flag": flag.tolist()},
        events=[[] for _ in range(n)],
        regimes=[None] * n,
    )
    return opens, closes, dsl_input


def _run(opens, closes, dsl_input, n_trials: int):
    cost = CostModel(taker_bps=4, slippage_bps=2)  # 12bps round trip
    trades = run_backtest(
        WHEN, "long", "1h", cost, dsl_input.timestamps, opens, closes, BAR_MS, dsl_input, entry_delay_bars=1
    )
    fires = compute_fires(WHEN, dsl_input)
    fwd = forward_returns_series(opens, closes, entry_delay_bars=1, horizon_bars=1, direction="long")
    return run_eep(
        trades, fwd, fires, horizon_bars=1, regimes=dsl_input.regimes, n_trials=n_trials, config=FAST_CONFIG
    )


@pytest.mark.slow
def test_strong_embedded_edge_is_adopted():
    opens, closes, dsl_input = _build_series(n=4000, embed_effect_bps=60.0, seed=1)
    result = _run(opens, closes, dsl_input, n_trials=1)
    assert result.verdict.verdict == "ADOPT", result.verdict.reasons


@pytest.mark.slow
def test_pure_noise_edge_is_not_adopted():
    opens, closes, dsl_input = _build_series(n=4000, embed_effect_bps=0.0, seed=2)
    result = _run(opens, closes, dsl_input, n_trials=1)
    assert result.verdict.verdict != "ADOPT", result.verdict.reasons


@pytest.mark.slow
def test_marginal_edge_found_via_many_trials_is_not_adopted():
    """The core PDF-W1 regression guard: a marginal effect that might pass at
    n_trials=1 must not clear the bar once discovery-search trial cost is
    counted (docs/00 §2.2 W1, docs/05 §3.7)."""
    opens, closes, dsl_input = _build_series(n=2500, embed_effect_bps=15.0, seed=3)
    result_1 = _run(opens, closes, dsl_input, n_trials=1)
    result_many = _run(opens, closes, dsl_input, n_trials=200)
    dsr_1 = next(m.value for m in result_1.metrics if m.segment == "wf:oos" and m.metric == "dsr")
    dsr_many = next(m.value for m in result_many.metrics if m.segment == "wf:oos" and m.metric == "dsr")
    assert dsr_many <= dsr_1
    assert result_many.verdict.verdict != "ADOPT"


def test_eep_config_for_run_kind_gives_screen_runs_a_cheaper_config():
    # docs/05 §2: screen is a "簡易EEP" -- 2026-07 design audit TASK-5.
    assert eep_config_for_run_kind("screen") is SCREEN_EEP_CONFIG
    assert SCREEN_EEP_CONFIG.permutation_iterations < FULL_EEP_CONFIG.permutation_iterations
    assert SCREEN_EEP_CONFIG.bootstrap_iterations < FULL_EEP_CONFIG.bootstrap_iterations


@pytest.mark.parametrize("run_kind", ["full", "incremental", "decay_check", "anything-else"])
def test_eep_config_for_run_kind_defaults_everything_else_to_full_rigor(run_kind):
    assert eep_config_for_run_kind(run_kind) is FULL_EEP_CONFIG
