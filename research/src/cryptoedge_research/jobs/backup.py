"""Weekly D1 -> R2 Parquet backup (docs/12 §3): every whitelisted table
dumped to `backups/d1/{date}/{table}.parquet`, with an 8-generation
rolling retention. D1 Time Travel's Free-plan retention window is short,
so this is the primary recovery mechanism, not a belt-and-suspenders
extra (2026-07 review, Task 7).
"""

from __future__ import annotations

import datetime
import logging
import os
import sys

import pandas as pd

from cryptoedge_research.io.internal_client import InternalApiClient
from cryptoedge_research.io.lake import delete_prefix, list_prefix, write_parquet

logger = logging.getLogger(__name__)

RETAIN_GENERATIONS = 8
PAGE_SIZE = 2000
BACKUP_ROOT = "backups/d1"


def _dump_table(client: InternalApiClient, table: str) -> pd.DataFrame:
    rows: list[dict] = []
    after_rowid = 0
    while True:
        page = client.get_backup_dump_page(table, after_rowid, limit=PAGE_SIZE)
        if not page:
            break
        rows.extend(page)
        after_rowid = page[-1]["_rowid"]
        if len(page) < PAGE_SIZE:
            break
    df = pd.DataFrame(rows)
    return df.drop(columns=["_rowid"]) if "_rowid" in df.columns else df


def _prune_old_generations(today: str) -> None:
    generations = sorted(key.rsplit("/", 1)[-1] for key in list_prefix(BACKUP_ROOT))
    generations = [g for g in generations if g != today]
    stale = generations[: max(0, len(generations) - (RETAIN_GENERATIONS - 1))]
    for generation in stale:
        logger.info("pruning stale backup generation %s", generation)
        delete_prefix(f"{BACKUP_ROOT}/{generation}")


def run_backup(client: InternalApiClient, today: str | None = None) -> dict[str, int]:
    """Dumps every backup table to R2 and prunes generations beyond
    `RETAIN_GENERATIONS`. Returns {table: row_count} for logging/assertions."""
    today = today or datetime.datetime.now(tz=datetime.UTC).strftime("%Y-%m-%d")
    tables = client.get_backup_tables()
    written: dict[str, int] = {}
    for table in tables:
        df = _dump_table(client, table)
        write_parquet(f"{BACKUP_ROOT}/{today}/{table}.parquet", df)
        written[table] = len(df)
        logger.info("backed up %s: %d row(s)", table, len(df))

    _prune_old_generations(today)
    return written


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    base_url = os.environ["CRYPTOEDGE_API_URL"]
    token = os.environ["RESEARCH_API_TOKEN"]

    with InternalApiClient(base_url, token) as client:
        written = run_backup(client)
    logger.info("weekly D1 backup complete: %d table(s)", len(written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
