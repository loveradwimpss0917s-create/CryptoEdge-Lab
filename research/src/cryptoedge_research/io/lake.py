"""R2 data lake access (docs/01 §4.3). research-worker reads Parquet
directly from R2's S3-compatible API — never through D1 (docs/13 §5: "Actions
は時系列を D1 から読まず R2 Parquet から読む").

Configured via environment variables so the same code path works against a
local filesystem in tests/dev (`CRYPTOEDGE_LAKE_LOCAL_PATH`) and against
real R2 in CI (`CRYPTOEDGE_R2_*`).
"""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq


def _local_root() -> Path | None:
    value = os.environ.get("CRYPTOEDGE_LAKE_LOCAL_PATH")
    return Path(value) if value else None


def read_candles(instrument_id: str, tf: str) -> pd.DataFrame:
    """Reads `curated/market/candles_{tf}/{instrument_id}/data.parquet`
    (docs/01 §4.3 R2 layout) and returns it sorted by `ts` ascending."""
    local_root = _local_root()
    if local_root is not None:
        path = local_root / "curated" / "market" / f"candles_{tf}" / instrument_id / "data.parquet"
        table = pq.read_table(path)
    else:
        # Production path: R2 via its S3-compatible API. Credentials/endpoint
        # come from standard AWS_* env vars (docs/13 §5); wired here but not
        # exercised by this sandbox's test suite, which has no R2 access.
        import pyarrow.fs as pafs

        endpoint = os.environ["CRYPTOEDGE_R2_ENDPOINT"]
        bucket = os.environ["CRYPTOEDGE_R2_BUCKET"]
        s3 = pafs.S3FileSystem(endpoint_override=endpoint)
        key = f"{bucket}/curated/market/candles_{tf}/{instrument_id}/data.parquet"
        table = pq.read_table(key, filesystem=s3)

    df = table.to_pandas()
    return df.sort_values("ts").reset_index(drop=True)
