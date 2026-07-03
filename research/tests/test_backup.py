"""Weekly D1 -> R2 Parquet backup job (docs/12 §3, 2026-07 review Task 7).
Exercises only the local-filesystem branch of io/lake.py, same convention
as the rest of the suite (no R2 access in this sandbox)."""

from __future__ import annotations

import pandas as pd
import pytest

from cryptoedge_research.io import lake
from cryptoedge_research.jobs import backup as backup_module
from cryptoedge_research.jobs.backup import run_backup


class _FakeInternalApiClient:
    def __init__(self, tables: dict[str, list[dict]]):
        self._tables = tables

    def get_backup_tables(self) -> list[str]:
        return list(self._tables.keys())

    def get_backup_dump_page(self, table: str, after_rowid: int, limit: int = 2000) -> list[dict]:
        rows = self._tables[table]
        return [r for r in rows if r["_rowid"] > after_rowid][:limit]


@pytest.fixture(autouse=True)
def _local_lake(tmp_path, monkeypatch):
    monkeypatch.setenv("CRYPTOEDGE_LAKE_LOCAL_PATH", str(tmp_path))
    return tmp_path


def test_dumps_each_table_to_its_own_parquet_file(tmp_path):
    client = _FakeInternalApiClient(
        {
            "edges": [{"_rowid": 1, "edge_id": "e1"}, {"_rowid": 2, "edge_id": "e2"}],
            "instruments": [{"_rowid": 1, "instrument_id": "i1"}]
        }
    )
    written = run_backup(client, today="2026-07-05")
    assert written == {"edges": 2, "instruments": 1}

    edges_df = pd.read_parquet(tmp_path / "backups" / "d1" / "2026-07-05" / "edges.parquet")
    assert list(edges_df["edge_id"]) == ["e1", "e2"]
    assert "_rowid" not in edges_df.columns


def test_pages_through_more_rows_than_one_page_size(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_module, "PAGE_SIZE", 2)
    rows = [{"_rowid": i, "v": i} for i in range(1, 6)]
    client = _FakeInternalApiClient({"edges": rows})
    run_backup(client, today="2026-07-05")
    df = pd.read_parquet(tmp_path / "backups" / "d1" / "2026-07-05" / "edges.parquet")
    assert list(df["v"]) == [1, 2, 3, 4, 5]


def test_prunes_generations_beyond_the_retention_window(tmp_path):
    for i in range(1, 11):
        lake.write_parquet(f"backups/d1/2026-01-{i:02d}/edges.parquet", pd.DataFrame({"v": [i]}))

    client = _FakeInternalApiClient({"edges": [{"_rowid": 1, "v": 99}]})
    run_backup(client, today="2026-01-11")

    remaining = sorted(p.name for p in (tmp_path / "backups" / "d1").iterdir())
    assert len(remaining) == 8
    assert "2026-01-11" in remaining  # today's own generation is always kept
    assert remaining[0] == "2026-01-04"  # the 3 oldest (01-03) were pruned
