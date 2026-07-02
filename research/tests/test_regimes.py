import numpy as np
import pandas as pd

from cryptoedge_research.regimes.rule_based import (
    RegimeThresholds,
    classify_liquidity,
    classify_regime,
    classify_trend,
    classify_vol,
    compute_adx,
    rolling_percentile_rank,
)

THRESHOLDS = RegimeThresholds()


def test_classify_trend_up_down_and_range():
    # classify_trend recomputes SMA200 internally from `close`, so we need a
    # series long enough for SMA200 to be defined (window=200) to exercise
    # the up/down/range logic meaningfully.
    n = 250
    base = pd.Series(np.linspace(50, 50, n))
    # First 200 bars flat at 50 (so SMA200 settles at 50), then diverge.
    close_long = base.copy()
    close_long.iloc[200] = 200.0  # sharp move above the 200-SMA
    close_long.iloc[201] = 1.0  # sharp move below
    adx_long = pd.Series([25.0] * n)  # strong trend throughout
    trend = classify_trend(close_long, adx_long, THRESHOLDS)
    assert trend.iloc[200] == "up"
    assert trend.iloc[201] == "down"
    assert pd.isna(trend.iloc[50])  # not enough history for SMA200 yet


def test_classify_trend_weak_adx_is_always_range():
    n = 250
    close = pd.Series(np.linspace(50, 150, n))  # clear uptrend in price
    weak_adx = pd.Series([5.0] * n)  # but ADX says there's no real trend strength
    trend = classify_trend(close, weak_adx, THRESHOLDS)
    assert (trend.iloc[200:] == "range").all()


def test_classify_vol_boundaries():
    pctile = pd.Series([0.1, 0.5, 0.95, np.nan])
    vol = classify_vol(pctile, THRESHOLDS)
    assert list(vol.iloc[:3]) == ["low", "high", "extreme"]
    assert pd.isna(vol.iloc[3])


def test_classify_liquidity_any_trigger_is_stressed():
    spread_pctile = pd.Series([0.95, 0.1, 0.1, 0.1])
    liq_z = pd.Series([0.0, 4.0, 0.0, 0.0])
    peg_dev = pd.Series([0.0, 0.0, 60.0, 10.0])
    liquidity = classify_liquidity(spread_pctile, liq_z, peg_dev, THRESHOLDS)
    assert list(liquidity) == ["stressed", "stressed", "stressed", "normal"]


def test_compute_adx_strong_trend_exceeds_weak_trend():
    n = 100
    idx = pd.RangeIndex(n)
    trending_close = pd.Series(np.linspace(100, 200, n), index=idx)
    trending_high = trending_close + 1
    trending_low = trending_close - 1
    adx_trend = compute_adx(trending_high, trending_low, trending_close)

    rng = np.random.default_rng(0)
    choppy_close = pd.Series(100 + np.cumsum(rng.normal(0, 0.01, n)), index=idx)
    choppy_high = choppy_close + 0.5
    choppy_low = choppy_close - 0.5
    adx_choppy = compute_adx(choppy_high, choppy_low, choppy_close)

    assert adx_trend.iloc[-1] > adx_choppy.iloc[-1]
    assert adx_trend.iloc[-1] > 20


def test_rolling_percentile_rank_monotonic_series():
    series = pd.Series(range(50))
    ranks = rolling_percentile_rank(series, window=50)
    # The final value is the maximum seen so far -> rank should be very high.
    assert ranks.iloc[-1] > 0.9


def test_classify_regime_end_to_end_shapes():
    n = 260
    idx = pd.RangeIndex(n)
    close = pd.Series(np.linspace(100, 150, n), index=idx)
    high = close + 1
    low = close - 1
    spread = pd.Series(np.random.default_rng(1).uniform(1, 5, n), index=idx)
    liq_z = pd.Series(np.zeros(n), index=idx)
    peg_dev = pd.Series(np.zeros(n), index=idx)

    result = classify_regime(close, high, low, spread, liq_z, peg_dev)
    assert list(result.columns) == ["trend", "vol", "liquidity"]
    assert len(result) == n
    assert result["liquidity"].iloc[-1] == "normal"
