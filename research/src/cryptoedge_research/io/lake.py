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
import pyarrow as pa
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


def write_parquet(key: str, df: pd.DataFrame) -> None:
    """Writes `df` to R2 (or the local dev root) at `key`, relative to the
    lake root — e.g. `backups/d1/2026-07-05/edges.parquet` (docs/12 §3).
    Mirrors `read_candles`'s local-vs-R2 branching (2026-07 review, Task 7)."""
    table = pa.Table.from_pandas(df, preserve_index=False)
    local_root = _local_root()
    if local_root is not None:
        path = local_root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, path)
        return

    import pyarrow.fs as pafs

    endpoint = os.environ["CRYPTOEDGE_R2_ENDPOINT"]
    bucket = os.environ["CRYPTOEDGE_R2_BUCKET"]
    s3 = pafs.S3FileSystem(endpoint_override=endpoint)
    pq.write_table(table, f"{bucket}/{key}", filesystem=s3)


def list_prefix(prefix: str) -> list[str]:
    """Lists keys directly under `prefix` (docs/12 §3: used to find and prune
    old backup generations). Returns bare keys relative to the lake root,
    matching what `write_parquet`/`read_candles` accept."""
    local_root = _local_root()
    if local_root is not None:
        base = local_root / prefix
        if not base.exists():
            return []
        return sorted(f"{prefix}/{p.name}" for p in base.iterdir())

    import pyarrow.fs as pafs

    endpoint = os.environ["CRYPTOEDGE_R2_ENDPOINT"]
    bucket = os.environ["CRYPTOEDGE_R2_BUCKET"]
    s3 = pafs.S3FileSystem(endpoint_override=endpoint)
    selector = pafs.FileSelector(f"{bucket}/{prefix}", recursive=False, allow_not_found=True)
    infos = s3.get_file_info(selector)
    return sorted(info.path.removeprefix(f"{bucket}/") for info in infos)


def delete_prefix(prefix: str) -> None:
    """Recursively deletes everything under `prefix` (docs/12 §3: pruning a
    retired backup generation)."""
    local_root = _local_root()
    if local_root is not None:
        base = local_root / prefix
        if base.exists():
            import shutil

            shutil.rmtree(base)
        return

    import pyarrow.fs as pafs

    endpoint = os.environ["CRYPTOEDGE_R2_ENDPOINT"]
    bucket = os.environ["CRYPTOEDGE_R2_BUCKET"]
    s3 = pafs.S3FileSystem(endpoint_override=endpoint)
    s3.delete_dir(f"{bucket}/{prefix}")
