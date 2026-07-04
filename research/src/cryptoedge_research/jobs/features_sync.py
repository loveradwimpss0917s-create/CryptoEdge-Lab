"""Feature Store v1 sync (docs/04 §3, 2026-07 design audit TASK-2, extended
TASK-3): computes the price + deriv feature sets (features/registry.py)
from R2 candles (+ R2-mirrored funding/OI/long-short-ratio/liquidation
tables, TASK-3) and writes the result back to R2 for
`jobs/on_demand.py`/`jobs/nightly.py` to join onto the bar series before
running the EEP. Registers what it computed in D1 `feature_defs` (docs/02)
so it's traceable from spec.

Run weekly, piggybacking on lake-sync.yml the same way `jobs/lake_sync.py`
does — candles (and, for deriv features, jobs/deriv_sync.py's backfill)
need to have landed in R2 first.
"""

from __future__ import annotations

import logging
import os
import sys

import pandas as pd

from cryptoedge_research.features.compute import compute_features
from cryptoedge_research.features.registry import FEATURES
from cryptoedge_research.io import lake
from cryptoedge_research.io.internal_client import FeatureDefInput, InternalApiClient
from cryptoedge_research.jobs.lake_sync import BACKFILL_TARGETS

logger = logging.getLogger(__name__)

FEATURE_SET_VERSION = "v1"

_HOUR_MS = 3_600_000

# ratio_type -> merged column name (jobs/deriv_sync.py's _RATIO_COLUMNS
# produces these ratio_type values; "taker_volume" isn't consumed by any
# registered feature yet, so it's left out of the merge).
_LS_RATIO_COLUMNS = {"top_trader_position": "ls_top_trader_position", "all_account": "ls_all_account"}


def _read_curated_for_instrument(table: str, instrument_id: str) -> pd.DataFrame | None:
    """The R2 mirror `jobs.lake_sync.sync_d1_curated` writes for `table`,
    filtered to one instrument and sorted by ts -- or `None` if that table
    hasn't been mirrored yet (first-ever run, before any lake-sync) *or*
    was mirrored with zero rows (a genuinely empty D1 table serializes to
    a columnless parquet, which is functionally the same "nothing to
    merge" case; found live, 2026-07: this crashed with `KeyError:
    'instrument_id'` before this guard existed)."""
    try:
        df = lake.read_parquet(f"curated/market/{table}/data.parquet")
    except OSError:
        return None
    if "instrument_id" not in df.columns:
        return None
    return df[df["instrument_id"] == instrument_id].sort_values("ts").reset_index(drop=True)


def _merge_deriv_columns(candles: pd.DataFrame, instrument_id: str) -> pd.DataFrame:
    """Joins funding/OI/long-short-ratio/liquidation history onto the 1h
    candle grid (docs/03 §2.1-2.2, 2026-07 design audit TASK-3). Funding/OI/
    L-S are forward-filled onto each hour (`merge_asof`, backward direction
    only -- never peeks at a future value); liquidation notional is summed
    per hour and missing hours filled 0 (no liquidation that hour is a real
    known value, unlike funding/OI/L-S's "no data yet")."""
    df = candles.sort_values("ts").reset_index(drop=True)

    funding = _read_curated_for_instrument("funding_rates", instrument_id)
    if funding is not None and len(funding) > 0:
        df = pd.merge_asof(
            df,
            funding[["ts", "rate"]].rename(columns={"rate": "funding_rate"}),
            on="ts",
            direction="backward",
        )
    else:
        df["funding_rate"] = float("nan")

    oi = _read_curated_for_instrument("open_interest", instrument_id)
    if oi is not None and len(oi) > 0:
        df = pd.merge_asof(df, oi[["ts", "oi_base"]], on="ts", direction="backward")
    else:
        df["oi_base"] = float("nan")

    ls = _read_curated_for_instrument("long_short_ratios", instrument_id)
    ls_columns_found: set[str] = set()
    if ls is not None and len(ls) > 0:
        pivoted = ls.pivot_table(index="ts", columns="ratio_type", values="ls_ratio").reset_index()
        for ratio_type, column in _LS_RATIO_COLUMNS.items():
            if ratio_type in pivoted.columns:
                ls_columns_found.add(column)
                df = pd.merge_asof(
                    df,
                    pivoted[["ts", ratio_type]].rename(columns={ratio_type: column}),
                    on="ts",
                    direction="backward",
                )
    for column in _LS_RATIO_COLUMNS.values():
        if column not in ls_columns_found:
            df[column] = float("nan")

    liq = _read_curated_for_instrument("liquidations_5m", instrument_id)
    if liq is not None and len(liq) > 0:
        liq = liq[liq["source_id"] == "binance_data_vision"].copy()
        liq["ts"] = (liq["ts"] // _HOUR_MS) * _HOUR_MS
        hourly = liq.groupby("ts", as_index=False)[["long_liq_usd", "short_liq_usd"]].sum()
        hourly["liq_notional_1h"] = hourly["long_liq_usd"] + hourly["short_liq_usd"]
        df = df.merge(hourly[["ts", "liq_notional_1h"]], on="ts", how="left")
        df["liq_notional_1h"] = df["liq_notional_1h"].fillna(0.0)
    else:
        df["liq_notional_1h"] = float("nan")

    return df


def sync_features_for_instrument(instrument_id: str) -> int:
    """Computes and writes the v1 feature set for one instrument's 1h
    candles. Returns 0 (no-op) if there's no candle data yet -- either the
    file doesn't exist at all (lake.read_candles raises OSError) or it's
    empty -- rather than writing an empty/malformed features file."""
    try:
        candles = lake.read_candles(instrument_id, "1h")
    except OSError:
        return 0
    if len(candles) == 0:
        return 0
    df = _merge_deriv_columns(candles, instrument_id)
    features = compute_features(df)
    key = f"features/{FEATURE_SET_VERSION}/{instrument_id}/1h/data.parquet"
    lake.write_parquet(key, features)
    return len(features)


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    base_url = os.environ["CRYPTOEDGE_API_URL"]
    token = os.environ["RESEARCH_API_TOKEN"]

    with InternalApiClient(base_url, token) as client:
        client.submit_feature_defs(
            [
                FeatureDefInput(
                    feature_id=f"{FEATURE_SET_VERSION}.{f.name}",
                    version=1,
                    spec={"base": f.base, "feature_set_version": FEATURE_SET_VERSION},
                    cadence=f.cadence,
                    lookback_required=f"{f.lookback_bars}bars",
                    family=f.family,
                )
                for f in FEATURES
            ]
        )
        for target in BACKFILL_TARGETS:
            written = sync_features_for_instrument(target.instrument_id)
            logger.info("synced %d feature row(s) for %s", written, target.instrument_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
