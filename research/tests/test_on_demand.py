"""Exercises the pure, I/O-free core of jobs/on_demand.py against a
synthetic embedded-effect dataset — the same style of check as
test_pipeline.py, but going through the edge_version JSON shape exactly
as the internal API would hand it back (docs/08 GET /internal/edge-versions/:id)."""

import json

import numpy as np
import pandas as pd
import pytest

from cryptoedge_research.eval.pipeline import EepConfig
from cryptoedge_research.jobs.on_demand import run_eep_for_edge_version

BAR_MS = 3_600_000


def _edge_version(when: dict, direction: str = "long", horizon: str = "1h") -> dict:
    return {
        "version_id": "v1",
        "edge_id": "e1",
        "semver": "1.0.0",
        "signal_spec": json.dumps(
            {
                "when": when,
                "entry": {"delay_bars": 1, "price": "open"},
                "exit": {"horizon": horizon},
                "direction": direction,
            }
        ),
        "params": "{}",
        "instrument_id": "BTCUSDT.BINANCE.PERP",
        "direction": direction,
        "horizon": horizon,
        "cost_model": json.dumps({"taker_bps": 4, "slippage_bps": 2, "funding_included": False}),
    }


def _synthetic_price_df(n: int, embed_effect_bps: float, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 25, n)
    flag = (rng.random(n) < 0.08).astype(float)
    log_returns = noise / 10_000.0
    for i in range(n - 2):
        if flag[i] > 0.5:
            log_returns[i + 2] += embed_effect_bps / 10_000.0
    prices = np.exp(np.cumsum(log_returns) + np.log(100.0))
    return pd.DataFrame({"ts": [i * BAR_MS for i in range(n)], "open": prices, "close": prices, "flag": flag})


@pytest.mark.slow
def test_run_eep_for_edge_version_adopts_a_real_embedded_effect():
    price_df = _synthetic_price_df(4000, embed_effect_bps=60.0, seed=1)
    edge_version = _edge_version({"cmp": [{"feature": "flag"}, ">", 0.5]})

    config = EepConfig(permutation_iterations=300, bootstrap_iterations=500, seed=42)
    result = run_eep_for_edge_version(edge_version, price_df, BAR_MS, n_trials=1, config=config)
    assert result.verdict.verdict == "ADOPT", result.verdict.reasons


@pytest.mark.slow
def test_run_eep_for_edge_version_rejects_pure_noise():
    price_df = _synthetic_price_df(4000, embed_effect_bps=0.0, seed=2)
    edge_version = _edge_version({"cmp": [{"feature": "flag"}, ">", 0.5]})

    config = EepConfig(permutation_iterations=300, bootstrap_iterations=500, seed=42)
    result = run_eep_for_edge_version(edge_version, price_df, BAR_MS, n_trials=1, config=config)
    assert result.verdict.verdict != "ADOPT"


def test_short_direction_is_wired_through_edge_version():
    price_df = pd.DataFrame(
        {
            "ts": [i * BAR_MS for i in range(5)],
            "open": [100.0, 100.0, 90.0, 90.0, 90.0],
            "close": [100.0, 100.0, 90.0, 90.0, 90.0],
            "flag": [1.0, 0.0, 0.0, 0.0, 0.0],
        }
    )
    edge_version = _edge_version({"cmp": [{"feature": "flag"}, ">", 0.5]}, direction="short")
    result = run_eep_for_edge_version(edge_version, price_df, BAR_MS, n_trials=1)
    trade_metric = next(m for m in result.metrics if m.segment == "overall" and m.metric == "trades")
    assert trade_metric.value == 1
