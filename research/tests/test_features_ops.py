"""Numeric + look-ahead checks for the feature transformation grammar
(docs/04 §3.2, 2026-07 design audit TASK-2). "Look-ahead safe" here means:
truncating a series to its first N rows and recomputing must reproduce
exactly the same first N values as computing over the full series — i.e.
no operator ever peeks past the row it's currently labeling."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from cryptoedge_research.features import ops


def _assert_no_lookahead(fn, kwargs: dict, truncate_at: int) -> None:
    full = fn(**kwargs)
    truncated_kwargs = {
        name: (v.iloc[:truncate_at] if isinstance(v, pd.Series) else v) for name, v in kwargs.items()
    }
    truncated = fn(**truncated_kwargs)
    pd.testing.assert_series_equal(
        truncated.reset_index(drop=True), full.iloc[:truncate_at].reset_index(drop=True)
    )


def test_chg_is_a_plain_diff():
    s = pd.Series([1.0, 2.0, 4.0, 7.0])
    result = ops.chg(s, 1)
    assert result.tolist()[1:] == [1.0, 2.0, 3.0]
    assert np.isnan(result.iloc[0])


def test_pctchg_matches_manual_calculation():
    s = pd.Series([100.0, 110.0, 121.0])
    result = ops.pctchg(s, 1)
    assert result.iloc[1] == pytest.approx(10.0)
    assert result.iloc[2] == pytest.approx(10.0)


def test_z_score_matches_manual_calculation():
    s = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0])
    result = ops.z(s, 5)
    # window mean=3, population std=sqrt(2); last value 5.0 -> z=(5-3)/sqrt(2)
    assert result.iloc[4] == pytest.approx(2.0 / (2.0**0.5))
    assert np.isnan(result.iloc[3])  # window not yet full


def test_pctile_ranks_the_current_value_within_its_window():
    s = pd.Series([5.0, 1.0, 2.0, 3.0, 4.0])  # window of 5, current (last) value = 4.0
    result = ops.pctile(s, 5)
    # 4.0 is the 4th smallest of [5,1,2,3,4] -> rank 4/5 = 80%
    assert result.iloc[4] == pytest.approx(80.0)


def test_ma_ratio_is_one_for_a_constant_series():
    s = pd.Series([10.0] * 10)
    result = ops.ma_ratio(s, 3, 5)
    assert result.iloc[-1] == pytest.approx(1.0)


def test_realized_vol_is_zero_for_a_constant_growth_rate():
    s = pd.Series([100.0 * (1.01**i) for i in range(10)])
    result = ops.realized_vol(s, 5)
    assert result.iloc[-1] == pytest.approx(0.0, abs=1e-9)


def test_atr_equals_high_minus_low_when_no_gaps():
    high = pd.Series([102.0, 103.0, 104.0])
    low = pd.Series([98.0, 99.0, 100.0])
    close = pd.Series([100.0, 101.0, 102.0])
    result = ops.atr(high, low, close, 2)
    assert result.iloc[-1] == pytest.approx(4.0)


def test_sma_dist_pct_is_zero_on_a_flat_series():
    s = pd.Series([50.0] * 5)
    result = ops.sma_dist_pct(s, 3)
    assert result.iloc[-1] == pytest.approx(0.0)


def test_rolling_high_dist_is_zero_at_a_new_high():
    high = pd.Series([10.0, 12.0, 11.0])
    close = pd.Series([10.0, 12.0, 12.0])
    result = ops.rolling_high_dist(high, close, 3)
    assert result.iloc[-1] == pytest.approx(0.0)


def test_rolling_ratio_of_equal_series_is_one():
    s = pd.Series([1.0, 2.0, 3.0, 4.0])
    result = ops.rolling_ratio(s, s, 2)
    assert result.iloc[-1] == pytest.approx(1.0)


@pytest.mark.parametrize(
    "fn,kwargs",
    [
        (ops.chg, {"series": pd.Series(np.random.default_rng(1).normal(size=50)), "window": 5}),
        (ops.pctchg, {"series": pd.Series(np.random.default_rng(2).normal(100, 5, size=50)), "window": 5}),
        (ops.z, {"series": pd.Series(np.random.default_rng(3).normal(size=50)), "window": 10}),
        (ops.pctile, {"series": pd.Series(np.random.default_rng(4).normal(size=50)), "window": 10}),
        (
            ops.realized_vol,
            {
                "close": pd.Series(np.random.default_rng(6).normal(100, 5, size=50).cumsum() + 100),
                "window": 10,
            },
        ),
    ],
)
def test_operators_never_look_ahead(fn, kwargs):
    _assert_no_lookahead(fn, kwargs, truncate_at=30)


def test_ma_ratio_never_looks_ahead():
    rng = np.random.default_rng(5)
    s = pd.Series(rng.normal(100, 5, size=50))
    _assert_no_lookahead(ops.ma_ratio, {"series": s, "short": 3, "long": 10}, truncate_at=30)


def test_atr_never_looks_ahead():
    rng = np.random.default_rng(7)
    close = pd.Series(rng.normal(100, 2, size=50).cumsum() + 1000)
    high = close + rng.uniform(0, 2, size=50)
    low = close - rng.uniform(0, 2, size=50)
    _assert_no_lookahead(ops.atr, {"high": high, "low": low, "close": close, "window": 5}, truncate_at=30)


def test_rolling_high_dist_never_looks_ahead():
    rng = np.random.default_rng(8)
    close = pd.Series(rng.normal(100, 2, size=50).cumsum() + 1000)
    high = close + rng.uniform(0, 2, size=50)
    _assert_no_lookahead(ops.rolling_high_dist, {"high": high, "close": close, "window": 5}, truncate_at=30)


def test_rolling_ratio_never_looks_ahead():
    rng = np.random.default_rng(9)
    num = pd.Series(rng.uniform(0, 10, size=50))
    den = pd.Series(rng.uniform(10, 20, size=50))
    kwargs = {"numerator": num, "denominator": den, "window": 5}
    _assert_no_lookahead(ops.rolling_ratio, kwargs, truncate_at=30)
