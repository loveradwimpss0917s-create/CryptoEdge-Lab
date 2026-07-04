"""jobs/features_sync.py's deriv-column merge (2026-07 design audit
TASK-3). R2 faked via io/lake.py's local-filesystem branch, same
convention as the rest of the suite."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from cryptoedge_research.io import lake
from cryptoedge_research.jobs.features_sync import _merge_deriv_columns, sync_features_for_instrument

BAR_MS = 3_600_000
INSTRUMENT = "BTCUSDT.BINANCE.PERP"


@pytest.fixture(autouse=True)
def _local_lake(tmp_path, monkeypatch):
    monkeypatch.setenv("CRYPTOEDGE_LAKE_LOCAL_PATH", str(tmp_path))
    return tmp_path


def _candles(n: int) -> pd.DataFrame:
    close = pd.Series(100.0 + np.arange(n, dtype=float))
    return pd.DataFrame(
        {
            "ts": [i * BAR_MS for i in range(n)],
            "open": close,
            "high": close,
            "low": close,
            "close": close,
            "volume": pd.Series([10.0] * n),
            "taker_buy_volume": pd.Series([5.0] * n),
        }
    )


def test_merge_deriv_columns_fills_nan_when_nothing_is_mirrored_to_r2_yet():
    df = _merge_deriv_columns(_candles(5), INSTRUMENT)
    for column in ("funding_rate", "oi_base", "ls_all_account", "ls_top_trader_position", "liq_notional_1h"):
        assert df[column].isna().all()


def test_merge_deriv_columns_forward_fills_funding_and_oi_onto_the_hourly_grid():
    lake.write_parquet(
        "curated/market/funding_rates/data.parquet",
        pd.DataFrame(
            {"instrument_id": [INSTRUMENT, INSTRUMENT], "ts": [0, 2 * BAR_MS], "rate": [0.0001, 0.0002]}
        ),
    )
    lake.write_parquet(
        "curated/market/open_interest/data.parquet",
        pd.DataFrame({"instrument_id": [INSTRUMENT], "ts": [0], "oi_base": [12345.0]}),
    )

    df = _merge_deriv_columns(_candles(4), INSTRUMENT)
    # bar 1 (ts=1*BAR_MS) has no funding row of its own -> carries bar 0's forward.
    assert df.loc[df["ts"] == BAR_MS, "funding_rate"].iloc[0] == pytest.approx(0.0001)
    assert df.loc[df["ts"] == 2 * BAR_MS, "funding_rate"].iloc[0] == pytest.approx(0.0002)
    assert df["oi_base"].iloc[0] == pytest.approx(12345.0)
    assert df["oi_base"].iloc[-1] == pytest.approx(12345.0)  # forward-filled onto every later bar


def test_merge_deriv_columns_pivots_long_short_ratios_by_ratio_type():
    lake.write_parquet(
        "curated/market/long_short_ratios/data.parquet",
        pd.DataFrame(
            {
                "instrument_id": [INSTRUMENT, INSTRUMENT],
                "ratio_type": ["all_account", "top_trader_position"],
                "ts": [0, 0],
                "ls_ratio": [1.5, 2.0],
            }
        ),
    )
    df = _merge_deriv_columns(_candles(2), INSTRUMENT)
    assert df["ls_all_account"].iloc[0] == pytest.approx(1.5)
    assert df["ls_top_trader_position"].iloc[0] == pytest.approx(2.0)


def test_merge_deriv_columns_sums_liquidations_per_hour_and_fills_zero_elsewhere():
    lake.write_parquet(
        "curated/market/liquidations_5m/data.parquet",
        pd.DataFrame(
            {
                "instrument_id": [INSTRUMENT, INSTRUMENT],
                "ts": [0, 300_000],  # both within the first hourly bar
                "long_liq_usd": [1000.0, 500.0],
                "short_liq_usd": [0.0, 200.0],
                "events": [1, 1],
                "max_single_usd": [1000.0, 500.0],
                "source_id": ["binance_data_vision", "binance_data_vision"],
            }
        ),
    )
    df = _merge_deriv_columns(_candles(3), INSTRUMENT)
    assert df["liq_notional_1h"].iloc[0] == pytest.approx(1000.0 + 500.0 + 200.0)
    assert df["liq_notional_1h"].iloc[1] == pytest.approx(0.0)  # no liquidations that hour, not NaN


def test_sync_features_for_instrument_is_a_noop_with_no_candles():
    assert sync_features_for_instrument("NOPE.BINANCE.SPOT") == 0
