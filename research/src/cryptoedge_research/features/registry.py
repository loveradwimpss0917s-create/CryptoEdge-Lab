"""Feature Store v1 registry (docs/04 §3, 2026-07 design audit TASK-2:
"price系8本" — the price-only feature set, computable from candles alone
with no additional data source, chosen to unblock the largest number of
seed Edges for the smallest amount of new ingestion work; extended in
TASK-3 with a "deriv系" set once funding/OI/long-short-ratio/liquidation
history existed to compute them from, docs/03 §1 "レバレッジ構造系"/"清算").

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
    base: str  # candles/deriv column(s) read, for feature_defs.spec bookkeeping
    cadence: str
    lookback_bars: int  # informs feature_defs.lookback_required
    family: str  # feature_defs.family: "price" (candles-only) or "deriv" (funding/OI/L-S/liquidations)
    compute: FeatureFn


FEATURES: list[FeatureDef] = [
    FeatureDef(
        "ret_24h", "close", "1h", 24, "price",
        lambda df: ops.pctchg(df["close"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "rv_24h", "close", "1h", 24, "price",
        lambda df: ops.realized_vol(df["close"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "rv_30d_pctile_1y", "close", "1h", 365 * _BARS_PER_DAY, "price",
        lambda df: ops.pctile(ops.realized_vol(df["close"], 30 * _BARS_PER_DAY), 365 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "atr_14d", "high,low,close", "1h", 14 * _BARS_PER_DAY, "price",
        lambda df: ops.atr(df["high"], df["low"], df["close"], 14 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "sma200_dist_pct", "close", "1h", 200 * _BARS_PER_DAY, "price",
        lambda df: ops.sma_dist_pct(df["close"], 200 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "high_24h_dist", "high,close", "1h", 24, "price",
        lambda df: ops.rolling_high_dist(df["high"], df["close"], _BARS_PER_DAY),
    ),
    # docs/14 §4.8 weekly-breakout-continuation: same op as high_24h_dist,
    # just a 7d window -- no new operator needed.
    FeatureDef(
        "weekly_high_dist", "high,close", "1h", 7 * _BARS_PER_DAY, "price",
        lambda df: ops.rolling_high_dist(df["high"], df["close"], 7 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "taker_buy_ratio_24h", "taker_buy_volume,volume", "1h", 24, "price",
        lambda df: ops.rolling_ratio(df["taker_buy_volume"], df["volume"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "vol_ma_ratio_7_30", "volume", "1h", 30 * _BARS_PER_DAY, "price",
        lambda df: ops.ma_ratio(df["volume"], 7 * _BARS_PER_DAY, 30 * _BARS_PER_DAY),
    ),
    # Deriv-family features (docs/03 §1, 2026-07 design audit TASK-3):
    # computed from jobs/deriv_sync.py's funding/OI/long-short-ratio/
    # liquidation backfill, merged onto the candle grid by
    # jobs/features_sync.py. Perpetual futures only -- these columns are
    # all-NaN for spot instruments (no funding/OI/L-S/liquidations exist
    # there), which is the correct "not applicable" signal, not a case to
    # special-case around.
    FeatureDef(
        "funding_z_30d", "funding_rate", "1h", 30 * _BARS_PER_DAY, "deriv",
        lambda df: ops.z(df["funding_rate"], 30 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "funding_chg_24h", "funding_rate", "1h", 24, "deriv",
        lambda df: ops.chg(df["funding_rate"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "oi_chg_24h", "oi_base", "1h", 24, "deriv",
        lambda df: ops.pctchg(df["oi_base"], _BARS_PER_DAY),
    ),
    FeatureDef(
        "oi_pctile_1y", "oi_base", "1h", 365 * _BARS_PER_DAY, "deriv",
        lambda df: ops.pctile(df["oi_base"], 365 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "ls_all_account_z_30d", "ls_all_account", "1h", 30 * _BARS_PER_DAY, "deriv",
        lambda df: ops.z(df["ls_all_account"], 30 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "ls_top_trader_z_30d", "ls_top_trader_position", "1h", 30 * _BARS_PER_DAY, "deriv",
        lambda df: ops.z(df["ls_top_trader_position"], 30 * _BARS_PER_DAY),
    ),
    FeatureDef(
        "liq_notional_24h", "liq_notional_1h", "1h", 24, "deriv",
        lambda df: ops.rolling_sum(df["liq_notional_1h"], _BARS_PER_DAY),
    ),
]
