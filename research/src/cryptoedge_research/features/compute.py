"""Pure candles-DataFrame -> features-DataFrame transform (docs/04 §3,
2026-07 design audit TASK-2). No I/O — `jobs/features_sync.py` owns
reading candles from R2 and writing the result back."""

from __future__ import annotations

import pandas as pd

from cryptoedge_research.features.registry import FEATURES


def compute_features(candles: pd.DataFrame) -> pd.DataFrame:
    """`candles` needs `ts` plus whatever base columns FEATURES reference
    (open/high/low/close/volume/taker_buy_volume — the shape
    `io.lake.read_candles` returns), sorted by `ts` ascending. Returns a
    DataFrame with `ts` plus one column per FEATURES entry, same row count
    and order as `candles`."""
    out = pd.DataFrame({"ts": candles["ts"].to_numpy()})
    for feature in FEATURES:
        out[feature.name] = feature.compute(candles).to_numpy()
    return out
