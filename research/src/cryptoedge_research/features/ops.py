"""Feature transformation grammar (docs/04 §3.2, 2026-07 design audit
TASK-2): a small set of composable operators over a pandas Series, each
computed only from data up to and including the current row (`rolling`
with a fixed, non-relaxed `min_periods` — the window's first bars are
NaN rather than silently computed from a shorter, incomplete window,
which would otherwise mean the first labeled bar's "24h" figure is
actually a 3h figure). None of these use `.shift(-n)` or any other
forward-looking operation, so there is no look-ahead leakage regardless
of where in a series they're evaluated.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def chg(series: pd.Series, window: int) -> pd.Series:
    return series.diff(window)


def pctchg(series: pd.Series, window: int) -> pd.Series:
    return series.pct_change(window) * 100.0


def z(series: pd.Series, window: int) -> pd.Series:
    roll = series.rolling(window, min_periods=window)
    return (series - roll.mean()) / roll.std(ddof=0)


def pctile(series: pd.Series, window: int) -> pd.Series:
    """Rolling percentile rank (0-100) of the current value within its own
    trailing `window`-bar history (inclusive)."""

    def _rank(x: np.ndarray) -> float:
        return float((x <= x[-1]).sum()) / len(x) * 100.0

    return series.rolling(window, min_periods=window).apply(_rank, raw=True)


def ma_ratio(series: pd.Series, short: int, long: int) -> pd.Series:
    short_ma = series.rolling(short, min_periods=short).mean()
    long_ma = series.rolling(long, min_periods=long).mean()
    return short_ma / long_ma


def realized_vol(close: pd.Series, window: int) -> pd.Series:
    """Rolling std of log returns over `window` bars — realized volatility,
    left un-annualized (V1's horizons are all sub-week; a consumer that
    wants an annualized figure scales it itself)."""
    log_ret = np.log(close / close.shift(1))
    return log_ret.rolling(window, min_periods=window).std(ddof=0)


def atr(high: pd.Series, low: pd.Series, close: pd.Series, window: int) -> pd.Series:
    prev_close = close.shift(1)
    true_range = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    return true_range.rolling(window, min_periods=window).mean()


def sma_dist_pct(close: pd.Series, window: int) -> pd.Series:
    sma = close.rolling(window, min_periods=window).mean()
    return (close - sma) / sma * 100.0


def rolling_high_dist(high: pd.Series, close: pd.Series, window: int) -> pd.Series:
    """% distance of the current close below its trailing `window`-bar
    high (docs/04 §3.2's transform grammar; negative = below the recent
    high, 0 = at a new high)."""
    rolling_high = high.rolling(window, min_periods=window).max()
    return (close - rolling_high) / rolling_high * 100.0


def rolling_ratio(numerator: pd.Series, denominator: pd.Series, window: int) -> pd.Series:
    num_sum = numerator.rolling(window, min_periods=window).sum()
    den_sum = denominator.rolling(window, min_periods=window).sum()
    return num_sum / den_sum


def rolling_sum(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window, min_periods=window).sum()
