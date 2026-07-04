"""Feature Store v1 sync (docs/04 §3, 2026-07 design audit TASK-2):
computes the price-only feature set (features/registry.py) from R2
candles and writes it back to R2 for `jobs/on_demand.py`/`jobs/nightly.py`
to join onto the bar series before running the EEP. Registers what it
computed in D1 `feature_defs` (docs/02) so it's traceable from spec.

Run weekly, piggybacking on lake-sync.yml the same way `jobs/lake_sync.py`
does — candles need to have landed in R2 first.
"""

from __future__ import annotations

import logging
import os
import sys

from cryptoedge_research.features.compute import compute_features
from cryptoedge_research.features.registry import FEATURES
from cryptoedge_research.io import lake
from cryptoedge_research.io.internal_client import FeatureDefInput, InternalApiClient
from cryptoedge_research.jobs.lake_sync import BACKFILL_TARGETS

logger = logging.getLogger(__name__)

FEATURE_SET_VERSION = "v1"


def sync_features_for_instrument(instrument_id: str) -> int:
    """Computes and writes the v1 feature set for one instrument's 1h
    candles. Returns 0 (no-op) if there's no candle data yet rather than
    writing an empty/malformed features file."""
    candles = lake.read_candles(instrument_id, "1h")
    if len(candles) == 0:
        return 0
    features = compute_features(candles)
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
                    family="price",
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
