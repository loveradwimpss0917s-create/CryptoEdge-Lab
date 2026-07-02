"""Rule-based regime classification (docs/04 §6.1, primary/causal model —
the only regime source the EEP is allowed to backtest against, since it's
computable from data available strictly up to and including the current
day; docs/04 §6.2 reserves HMM for research/visualization use only).

trend:      close vs SMA200, gated by ADX (weak trend -> "range" regardless
            of which side of the SMA price is on)
vol:        30-day realized vol's percentile rank within the trailing year
            (p33 / p90 splits -> low / high / extreme)
liquidity:  "stressed" if spread is in the trailing year's top decile, OR
            a liquidation z-score exceeds 3, OR a stablecoin peg deviates
            more than 50bps — else "normal"
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


def sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window).mean()


def compute_adx(high: pd.Series, low: pd.Series, close: pd.Series, window: int = 14) -> pd.Series:
    """Wilder's ADX. Standard formulation: smoothed +DM/-DM and true range
    via an exponential moving average with alpha = 1/window (Wilder smoothing),
    then ADX = smoothed mean absolute difference of +DI/-DI."""
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)

    alpha = 1.0 / window
    ewm_kwargs = {"alpha": alpha, "adjust": False, "min_periods": window}
    atr = tr.ewm(**ewm_kwargs).mean()
    plus_dm_smooth = pd.Series(plus_dm, index=high.index).ewm(**ewm_kwargs).mean()
    minus_dm_smooth = pd.Series(minus_dm, index=high.index).ewm(**ewm_kwargs).mean()
    plus_di = 100 * plus_dm_smooth / atr
    minus_di = 100 * minus_dm_smooth / atr

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=alpha, adjust=False, min_periods=window).mean()
    return adx


def realized_vol(close: pd.Series, window: int = 30, periods_per_year: int = 365) -> pd.Series:
    log_ret = np.log(close).diff()
    return log_ret.rolling(window).std() * np.sqrt(periods_per_year)


def rolling_percentile_rank(series: pd.Series, window: int = 365) -> pd.Series:
    """Percentile rank (0-1) of each value within its own trailing `window`."""
    return series.rolling(window, min_periods=max(30, window // 4)).apply(
        lambda x: (x < x.iloc[-1]).mean(), raw=False
    )


@dataclass(frozen=True)
class RegimeThresholds:
    adx_trend_min: float = 20.0
    vol_low_pctile: float = 0.33
    vol_extreme_pctile: float = 0.90
    spread_stressed_pctile: float = 0.90
    liq_z_stressed: float = 3.0
    peg_dev_stressed_bps: float = 50.0


def classify_trend(close: pd.Series, adx: pd.Series, thresholds: RegimeThresholds) -> pd.Series:
    sma200 = sma(close, 200)
    trend = pd.Series("range", index=close.index)
    strong = adx >= thresholds.adx_trend_min
    trend[strong & (close > sma200)] = "up"
    trend[strong & (close <= sma200)] = "down"
    trend[sma200.isna() | adx.isna()] = None
    return trend


def classify_vol(rv_pctile: pd.Series, thresholds: RegimeThresholds) -> pd.Series:
    vol = pd.Series("high", index=rv_pctile.index)
    vol[rv_pctile <= thresholds.vol_low_pctile] = "low"
    vol[rv_pctile >= thresholds.vol_extreme_pctile] = "extreme"
    vol[rv_pctile.isna()] = None
    return vol


def classify_liquidity(
    spread_pctile: pd.Series,
    liq_zscore: pd.Series,
    peg_dev_bps: pd.Series,
    thresholds: RegimeThresholds,
) -> pd.Series:
    stressed = (
        (spread_pctile >= thresholds.spread_stressed_pctile)
        | (liq_zscore.abs() >= thresholds.liq_z_stressed)
        | (peg_dev_bps.abs() >= thresholds.peg_dev_stressed_bps)
    )
    liquidity = pd.Series("normal", index=spread_pctile.index)
    liquidity[stressed] = "stressed"
    liquidity[spread_pctile.isna() & liq_zscore.isna() & peg_dev_bps.isna()] = None
    return liquidity


def classify_regime(
    close: pd.Series,
    high: pd.Series,
    low: pd.Series,
    spread_bps: pd.Series,
    liq_zscore: pd.Series,
    peg_dev_bps: pd.Series,
    thresholds: RegimeThresholds | None = None,
) -> pd.DataFrame:
    """All inputs are daily series (docs/04 §6.3: rule-based labels are
    computed once per day) indexed identically. Returns a DataFrame with
    trend/vol/liquidity columns, `None` wherever there isn't yet enough
    trailing history to classify."""
    thresholds = thresholds or RegimeThresholds()
    adx = compute_adx(high, low, close)
    trend = classify_trend(close, adx, thresholds)

    rv = realized_vol(close)
    rv_pctile = rolling_percentile_rank(rv)
    vol = classify_vol(rv_pctile, thresholds)

    spread_pctile = rolling_percentile_rank(spread_bps)
    liquidity = classify_liquidity(spread_pctile, liq_zscore, peg_dev_bps, thresholds)

    return pd.DataFrame({"trend": trend, "vol": vol, "liquidity": liquidity})
