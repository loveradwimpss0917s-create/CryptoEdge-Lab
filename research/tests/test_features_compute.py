"""compute_features (docs/04 §3, 2026-07 design audit TASK-2): the
candles-DataFrame -> features-DataFrame join contract that
jobs/features_sync.py writes to R2 and jobs/on_demand.py reads back."""

from __future__ import annotations

import numpy as np
import pandas as pd

from cryptoedge_research.features.compute import compute_features
from cryptoedge_research.features.registry import FEATURES

BAR_MS = 3_600_000


def _synthetic_candles(n: int) -> pd.DataFrame:
    """Includes the deriv-family features' base columns
    (docs/03 §1, 2026-07 design audit TASK-3) alongside price ones --
    `jobs/features_sync.py`'s `_merge_deriv_columns` guarantees these exist
    (NaN-filled where there's no real data) before calling
    `compute_features`, so a bare candles frame without them isn't a shape
    `compute_features` is ever actually called with."""
    rng = np.random.default_rng(0)
    close = pd.Series(100.0 + rng.normal(0, 1, n).cumsum())
    high = close + rng.uniform(0, 1, n)
    low = close - rng.uniform(0, 1, n)
    volume = pd.Series(rng.uniform(10, 100, n))
    taker_buy_volume = volume * rng.uniform(0.3, 0.7, n)
    return pd.DataFrame(
        {
            "ts": [i * BAR_MS for i in range(n)],
            "open": close,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
            "taker_buy_volume": taker_buy_volume,
            "funding_rate": pd.Series(rng.normal(0.0001, 0.00005, n)),
            "oi_base": pd.Series(rng.uniform(10000, 20000, n)),
            "ls_all_account": pd.Series(rng.uniform(0.8, 1.5, n)),
            "ls_top_trader_position": pd.Series(rng.uniform(0.8, 1.5, n)),
            "liq_notional_1h": pd.Series(rng.uniform(0, 1_000_000, n)),
        }
    )


def test_compute_features_returns_ts_plus_one_column_per_registered_feature():
    candles = _synthetic_candles(100)
    features = compute_features(candles)
    assert list(features.columns) == ["ts"] + [f.name for f in FEATURES]
    assert len(features) == len(candles)
    assert features["ts"].tolist() == candles["ts"].tolist()


def test_compute_features_is_nan_before_a_features_lookback_window_fills():
    candles = _synthetic_candles(100)
    features = compute_features(candles)
    # ret_24h needs 24 bars of history; bar 0 can't have a 24h return yet.
    assert np.isnan(features["ret_24h"].iloc[0])
    assert not np.isnan(features["ret_24h"].iloc[24])


def test_compute_features_on_a_short_series_is_all_nan_for_long_lookback_features():
    candles = _synthetic_candles(10)  # far short of sma200_dist_pct's 4800-bar window
    features = compute_features(candles)
    assert features["sma200_dist_pct"].isna().all()


def test_compute_features_is_all_nan_for_deriv_features_when_the_instrument_has_no_deriv_data():
    # Mirrors what jobs.features_sync._merge_deriv_columns produces for a
    # spot instrument: the candles columns are real, the deriv columns
    # exist but are entirely NaN (2026-07 design audit TASK-3).
    candles = _synthetic_candles(100)
    for column in ("funding_rate", "oi_base", "ls_all_account", "ls_top_trader_position", "liq_notional_1h"):
        candles[column] = float("nan")
    features = compute_features(candles)
    assert features["funding_z_30d"].isna().all()
    assert features["oi_chg_24h"].isna().all()
    assert features["ls_all_account_z_30d"].isna().all()
    assert features["liq_notional_24h"].isna().all()
