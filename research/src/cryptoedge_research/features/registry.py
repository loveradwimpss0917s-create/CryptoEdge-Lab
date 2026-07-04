"""Feature Store v1 registry (docs/04 §3, 2026-07 design audit TASK-2:
"price系8本" — the price-only feature set, computable from candles alone
with no additional data source, chosen to unblock the largest number of
seed Edges for the smallest amount of new ingestion work).

V1 runs on the 1h candle series (not docs/04 §3.1's 1d-primary cadence):
every P0 seed Edge's horizon is hours, not days, so hourly features avoid
throwing away resolution the EEP would otherwise need.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import pandas as pd

from cryptoedge_research.features import ops

FeatureFn = Callable[[pd.DataFrame], pd.Series]

_BARS_PER_DAY = 24  # 1h cadence (module docstring)


@dataclass(frozen=True)
class FeatureDef:
    name: str
    base: str  # candles column(s) read, for feature_defs.spec bookkeeping
    cadence: str
    lookback_bars: int  # informs feature_defs.lookback_required
    compute: FeatureFn


FEATURES: list[FeatureDef] = [
    FeatureDef(
        "ret_24h", "close", "1h", 24,
        lambda df: ops.pctchg(df["close"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "rv_24h", "close", "1h", 24,
        lambda df: ops.realized_vol(df["close"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "rv_30d_pctile_1y", "close", "1h", 365 * _BARS_PER_DAY,
        lambda df: ops.pctile(ops.realized_vol(df["close"], 30 * _BARS_PER_DAY), 365 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "atr_14d", "high,low,close", "1h", 14 * _BARS_PER_DAY,
        lambda df: ops.atr(df["high"], df["low"], df["close"], 14 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "sma200_dist_pct", "close", "1h", 200 * _BARS_PER_DAY,
        lambda df: ops.sma_dist_pct(df["close"], 200 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "high_24h_dist", "high,close", "1h", 24,
        lambda df: ops.rolling_high_dist(df["high"], df["close"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "taker_buy_ratio_24h", "taker_buy_volume,volume", "1h", 24,
        lambda df: ops.rolling_ratio(df["taker_buy_volume"], df["volume"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "vol_ma_ratio_7_30", "volume", "1h", 30 * _BARS_PER_DAY,
        lambda df: ops.ma_ratio(df["volume"], 7 * _BARS_PER_DAY, 30 * _BARS_PER_DAY),
    ),
]
