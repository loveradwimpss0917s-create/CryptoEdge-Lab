"""Historical backfill + D1-into-R2 sync + snapshot manifest (docs/01
§4.3-4.4, docs/03 §5, 2026-07 review Task 4). Four responsibilities, all
idempotent / safe to re-run:

1. `backfill_candles_for_target`: downloads Binance's public daily kline
   ZIPs from data.binance.vision — a static file host, not the rate-limited
   REST API Cloudflare Workers get blocked from (docs/03 §2.1) — and
   merges them into R2's curated candle Parquet (the same
   `curated/market/candles_{tf}/{instrument_id}/data.parquet` layout
   `io/lake.read_candles` already reads). Only ever fetches days newer
   than what's already stored, capped per run (docs/01 §4.1 "バックフィル
   は 80K 行/日以下にスロットリングし数日かけて流す") so a multi-year
   backfill spreads across repeated weekly runs instead of one job trying
   to do it all at once.
2. `sync_d1_curated`: mirrors the `metrics`/`open_interest` D1 tables into
   R2 Parquet via the existing `/internal/backup/dump` pagination (docs/12
   §3), so research-worker's "read time series from R2, never D1" rule
   (docs/13 §5) extends to these tables too.
3. `main()` also backfills `regimes_daily` via `nightly.compute_regime_history`
   (docs/04 §6): `jobs/nightly.py` only ever classifies *today*, so without
   this, every date before the day nightly.py first ran had no regime
   label — leaving `verdict.py`'s regime-segmented EV metrics with nothing
   to condition historical trades on.
4. `write_snapshot_manifest`: lists every curated file's key/size/mtime and
   writes it as the current snapshot (docs/01 §4.4). The manifest's own
   hash becomes `dataset_hash` — `jobs/on_demand.py` used to hardcode
   `"unknown"` here, meaning no eval_run recorded which data version it
   actually ran against.

NOTE: the Binance ZIP download/parse path can't be exercised against the
real data.binance.vision host from this sandbox (no outbound network
access here), and the CSV-header quirk handling in `_parse_klines_csv`
is based on Binance's documented format, not a fixture captured live —
same caveat `io/lake.py`'s R2 branch already carries.
"""

from __future__ import annotations

import datetime
import hashlib
import io
import json
import logging
import os
import sys
import zipfile
from dataclasses import dataclass

import httpx
import pandas as pd

from cryptoedge_research.io import lake
from cryptoedge_research.io.internal_client import InternalApiClient
from cryptoedge_research.jobs.nightly import compute_regime_history

logger = logging.getLogger(__name__)

_DATA_VISION_BASE = "https://data.binance.vision/data"

_KLINE_COLUMNS = [
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_asset_volume",
    "number_of_trades",
    "taker_buy_base_asset_volume",
    "taker_buy_quote_asset_volume",
    "ignore"
]


@dataclass(frozen=True)
class BackfillTarget:
    instrument_id: str
    binance_symbol: str
    market_path: str  # "spot" or "futures/um" — data.binance.vision's URL segment


# Mirrors workers/ingest/src/adapters/okx.ts's TRACKED_INSTRUMENTS
# instrument_id choices (docs/03 §2.1: kept as the legacy "BINANCE" label
# deliberately, since edge_versions.signal_spec references it directly).
BACKFILL_TARGETS = [
    BackfillTarget("BTCUSDT.BINANCE.PERP", "BTCUSDT", "futures/um"),
    BackfillTarget("BTCUSDT.BINANCE.SPOT", "BTCUSDT", "spot"),
    BackfillTarget("ETHUSDT.BINANCE.PERP", "ETHUSDT", "futures/um")
]

BACKFILL_TIMEFRAMES = ("1m", "1h", "1d")

# Rough listing start dates (docs/03 §5); a wrong guess just costs a few
# harmless 404s before the real start, so precision isn't critical here.
_DEFAULT_START_DATE = {
    "spot": {"1m": "2020-01-01", "1h": "2017-08-17", "1d": "2017-08-17"},
    "futures/um": {"1m": "2020-01-01", "1h": "2019-09-08", "1d": "2019-09-08"}
}

# docs/01 §4.1 "バックフィルは 80K 行/日以下にスロットリング": 1m bars are
# 1,440 rows/day, so its per-run day budget is much smaller than 1h/1d's.
_MAX_DAYS_PER_RUN = {"1m": 30, "1h": 365, "1d": 3650}

D1_CURATED_TABLES = ("metrics", "open_interest")


def _zip_url(market_path: str, symbol: str, tf: str, date: datetime.date) -> str:
    filename = f"{symbol}-{tf}-{date.isoformat()}.zip"
    return f"{_DATA_VISION_BASE}/{market_path}/daily/klines/{symbol}/{tf}/{filename}"


# Binance's kline CSVs switched to microsecond-precision open_time/close_time
# for some symbols/date ranges at some point in 2025 — not documented
# anywhere obvious, found live: a from-scratch backfill spanning 2019-2026
# wrote a `ts` column mixing millisecond-scale (old) and microsecond-scale
# (new) values, which crashed the *next* run's date math with
# "ValueError: year 58469 is out of range" (58469 ≈ what you get treating a
# microsecond value as milliseconds). No real millisecond timestamp will
# exceed this for a couple more centuries, so anything larger can only be
# microseconds.
_MAX_PLAUSIBLE_MS = 4_102_444_800_000  # 2100-01-01T00:00:00Z


def _normalize_ms(raw: pd.Series) -> pd.Series:
    values = raw.astype("int64")
    return values.where(values <= _MAX_PLAUSIBLE_MS, values // 1000)


def _parse_klines_csv(raw: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), header=None, names=_KLINE_COLUMNS)
    # Binance dumps from ~2024 onward ship an actual header row inside the
    # CSV; with header=None that reads as a data row instead. Detect and
    # drop it rather than assuming a fixed schema per date.
    if str(df.iloc[0]["open_time"]).strip().lower() == "open_time":
        df = df.iloc[1:].reset_index(drop=True)
    numeric_cols = [c for c in _KLINE_COLUMNS if c not in ("close_time", "ignore")]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col])
    return df


def _to_candle_frame(df: pd.DataFrame, instrument_id: str, tf: str) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "instrument_id": instrument_id,
            "tf": tf,
            "ts": _normalize_ms(df["open_time"]),
            "open": df["open"].astype(float),
            "high": df["high"].astype(float),
            "low": df["low"].astype(float),
            "close": df["close"].astype(float),
            "volume": df["volume"].astype(float),
            "quote_volume": df["quote_asset_volume"].astype(float),
            "taker_buy_volume": df["taker_buy_base_asset_volume"].astype(float),
            "trades": df["number_of_trades"].astype("int64")
        }
    )


def _fetch_daily_klines(
    http: httpx.Client, market_path: str, symbol: str, tf: str, date: datetime.date
) -> pd.DataFrame | None:
    """Returns `None` for a 404 (no data published for that day — either
    before the symbol/timeframe existed, or simply not-yet-published)."""
    url = _zip_url(market_path, symbol, tf, date)
    res = http.get(url)
    if res.status_code == 404:
        return None
    res.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        name = f"{symbol}-{tf}-{date.isoformat()}.csv"
        with zf.open(name) as f:
            return _parse_klines_csv(f.read())


def _merge_and_write_candles(instrument_id: str, tf: str, new_rows: pd.DataFrame) -> None:
    key = f"curated/market/candles_{tf}/{instrument_id}/data.parquet"
    try:
        existing = lake.read_candles(instrument_id, tf)
    except OSError:
        existing = new_rows.iloc[0:0]  # empty frame with matching columns
    combined = pd.concat([existing, new_rows], ignore_index=True)
    combined = combined.drop_duplicates(subset="ts", keep="last").sort_values("ts").reset_index(drop=True)
    lake.write_parquet(key, combined)


def backfill_candles_for_target(
    http: httpx.Client, target: BackfillTarget, tf: str, today: datetime.date | None = None
) -> int:
    """Fetches any daily klines newer than what R2 already has for this
    instrument/timeframe, up to `_MAX_DAYS_PER_RUN[tf]` days. Returns the
    number of new rows written (0 if already fully caught up for this
    run's budget)."""
    today = today or datetime.datetime.now(tz=datetime.UTC).date()
    try:
        existing = lake.read_candles(target.instrument_id, tf)
        last_ts = int(existing["ts"].max())
        last_date = datetime.datetime.fromtimestamp(last_ts / 1000, tz=datetime.UTC).date()
        start = last_date + datetime.timedelta(days=1)
    except OSError:
        start = datetime.date.fromisoformat(_DEFAULT_START_DATE[target.market_path][tf])

    if start >= today:
        return 0

    end = min(today, start + datetime.timedelta(days=_MAX_DAYS_PER_RUN[tf]))

    frames: list[pd.DataFrame] = []
    date = start
    while date < end:
        raw = _fetch_daily_klines(http, target.market_path, target.binance_symbol, tf, date)
        if raw is not None:
            frames.append(_to_candle_frame(raw, target.instrument_id, tf))
        date += datetime.timedelta(days=1)

    if not frames:
        return 0

    new_rows = pd.concat(frames, ignore_index=True)
    _merge_and_write_candles(target.instrument_id, tf, new_rows)
    logger.info(
        "backfilled %s %s: %d new row(s) (%s -> %s)", target.instrument_id, tf, len(new_rows), start, end
    )
    return len(new_rows)


def sync_d1_curated(client: InternalApiClient) -> dict[str, int]:
    """Mirrors `D1_CURATED_TABLES` into R2 Parquet, reusing the same
    keyset-paginated `/internal/backup/dump` route the weekly D1 backup
    uses (docs/12 §3)."""
    written: dict[str, int] = {}
    for table in D1_CURATED_TABLES:
        rows: list[dict] = []
        after_rowid = 0
        while True:
            page = client.get_backup_dump_page(table, after_rowid, limit=2000)
            if not page:
                break
            rows.extend(page)
            after_rowid = page[-1]["_rowid"]
            if len(page) < 2000:
                break
        df = pd.DataFrame(rows)
        if "_rowid" in df.columns:
            df = df.drop(columns=["_rowid"])
        lake.write_parquet(f"curated/market/{table}/data.parquet", df)
        written[table] = len(df)
        logger.info("synced D1 table %s to R2: %d row(s)", table, len(df))
    return written


def write_snapshot_manifest(today: str | None = None) -> str:
    """Lists every file under `curated/` (key/size/mtime, not content — see
    module docstring) and writes it as the current snapshot. Returns the
    dataset_hash that `jobs/on_demand.py` reads via `io.lake.read_dataset_hash`.

    The hash is computed from key+size only, deliberately excluding mtime
    and the `today` label: re-running this job with no actual data change
    (e.g. a backfill call that found nothing new) must yield the same
    dataset_hash, not a new one just because the wall-clock moved."""
    today = today or datetime.datetime.now(tz=datetime.UTC).strftime("%Y-%m-%d")
    files = sorted(lake.list_prefix_details("curated", recursive=True), key=lambda f: f["key"])
    manifest = {"generated_at": today, "files": files}
    manifest_bytes = json.dumps(manifest, sort_keys=True).encode("utf-8")
    fingerprint = [{"key": f["key"], "size": f["size"]} for f in files]
    dataset_hash = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode("utf-8")).hexdigest()

    lake.write_bytes(f"snapshots/{today}/manifest.json", manifest_bytes)
    lake.write_bytes("snapshots/latest/manifest.json", manifest_bytes)
    lake.write_bytes("snapshots/latest/dataset_hash.txt", dataset_hash.encode("utf-8"))
    logger.info(
        "wrote snapshot manifest for %s: %d file(s), dataset_hash=%s", today, len(files), dataset_hash
    )
    return dataset_hash


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    base_url = os.environ["CRYPTOEDGE_API_URL"]
    token = os.environ["RESEARCH_API_TOKEN"]

    # One-time safe diagnostic: reports shape, not content, of the R2
    # endpoint secret. Never logs the value itself — GitHub Actions would
    # mask an exact match anyway, but a value with extra whitespace
    # wouldn't match the secret's redaction pattern and could leak
    # (2026-07: added while chasing a "DNS Label" write failure that
    # reproduced cleanly against real R2 locally but not in CI with
    # byte-for-byte identical code, which points at the secret's actual
    # configured value rather than the code).
    raw_endpoint = os.environ.get("CRYPTOEDGE_R2_ENDPOINT", "")
    logger.info(
        "R2 endpoint diagnostic: length=%d has_leading_or_trailing_whitespace=%s starts_with_https=%s",
        len(raw_endpoint),
        raw_endpoint != raw_endpoint.strip(),
        raw_endpoint.strip().startswith("https://")
    )

    with httpx.Client(timeout=30.0) as http, InternalApiClient(base_url, token) as client:
        for target in BACKFILL_TARGETS:
            for tf in BACKFILL_TIMEFRAMES:
                backfill_candles_for_target(http, target, tf)
        sync_d1_curated(client)

        # docs/04 §6, 2026-07 review Task 4: nightly.py only ever classifies
        # *today*; without this, regimes_daily stayed empty for every date
        # before the day nightly.py first ran, so verdict.py's
        # regime-segmented EV metrics had nothing to condition on for
        # historical trades.
        regime_history = compute_regime_history()
        if regime_history:
            written = client.submit_regimes(regime_history)
            logger.info("backfilled %d regime row(s)", written)

    write_snapshot_manifest()
    return 0


if __name__ == "__main__":
    sys.exit(main())
