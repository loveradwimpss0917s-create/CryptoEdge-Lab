"""jobs/lake_sync.py (docs/01 §4.3-4.4, 2026-07 review Task 4). Exercises
everything except an actual connection to data.binance.vision: HTTP is
faked via httpx.MockTransport (no real network access in this sandbox),
and R2 is faked via io/lake.py's local-filesystem branch, same convention
as the rest of the suite."""

from __future__ import annotations

import datetime
import io
import zipfile

import httpx
import pandas as pd
import pytest

from cryptoedge_research.io import lake
from cryptoedge_research.jobs.lake_sync import (
    BackfillTarget,
    _fetch_daily_klines,
    _normalize_ms,
    _parse_klines_csv,
    _to_candle_frame,
    _zip_url,
    backfill_candles_for_target,
    sync_d1_curated,
    write_snapshot_manifest,
)

HEADERLESS_ROW = (
    "1704067200000,42283.58,42303.60,42270.00,42295.10,123.456,"
    "1704067259999,5220000.5,1000,60.0,2550000.2,0"
)
HEADER_ROW = (
    "open_time,open,high,low,close,volume,close_time,quote_asset_volume,"
    "number_of_trades,taker_buy_base_asset_volume,taker_buy_quote_asset_volume,ignore"
)


def _make_zip(symbol: str, tf: str, date: str, csv_text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(f"{symbol}-{tf}-{date}.csv", csv_text)
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _local_lake(tmp_path, monkeypatch):
    monkeypatch.setenv("CRYPTOEDGE_LAKE_LOCAL_PATH", str(tmp_path))
    return tmp_path


def test_zip_url_matches_data_binance_vision_layout():
    url = _zip_url("futures/um", "BTCUSDT", "1h", datetime.date(2024, 1, 1))
    assert url == "https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2024-01-01.zip"


def test_parse_klines_csv_handles_headerless_rows():
    df = _parse_klines_csv(HEADERLESS_ROW.encode())
    assert len(df) == 1
    assert df.iloc[0]["open_time"] == 1704067200000
    assert df.iloc[0]["close"] == 42295.10


def test_parse_klines_csv_drops_the_2024plus_header_row():
    df = _parse_klines_csv(f"{HEADER_ROW}\n{HEADERLESS_ROW}\n{HEADERLESS_ROW}".encode())
    assert len(df) == 2
    assert df["open_time"].dtype.kind in "iu"


def test_to_candle_frame_maps_columns_to_the_candles_schema():
    df = _parse_klines_csv(HEADERLESS_ROW.encode())
    candles = _to_candle_frame(df, "BTCUSDT.BINANCE.PERP", "1h")
    row = candles.iloc[0]
    assert row["instrument_id"] == "BTCUSDT.BINANCE.PERP"
    assert row["tf"] == "1h"
    assert row["ts"] == 1704067200000
    assert row["volume"] == 123.456
    assert row["quote_volume"] == 5220000.5
    assert row["taker_buy_volume"] == 60.0  # taker_buy_base_asset_volume
    assert row["trades"] == 1000


def test_normalize_ms_leaves_plausible_millisecond_values_alone():
    assert list(_normalize_ms(pd.Series([1704067200000]))) == [1704067200000]


def test_normalize_ms_divides_down_microsecond_scale_values():
    # Binance's CSVs switched some symbols/dates to microsecond-precision
    # open_time in 2025; a naive `.astype("int64")` treats that as
    # milliseconds and blows up downstream date math (found live:
    # ValueError: year 58469 is out of range).
    assert list(_normalize_ms(pd.Series([1_704_067_200_000_000]))) == [1704067200000]


def test_to_candle_frame_normalizes_microsecond_scale_open_time():
    row = HEADERLESS_ROW.replace("1704067200000", "1704067200000000")
    df = _parse_klines_csv(row.encode())
    candles = _to_candle_frame(df, "BTCUSDT.BINANCE.PERP", "1h")
    assert candles.iloc[0]["ts"] == 1704067200000


def test_fetch_daily_klines_returns_none_on_404():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        result = _fetch_daily_klines(http, "spot", "BTCUSDT", "1h", datetime.date(2024, 1, 1))
    assert result is None


def test_fetch_daily_klines_parses_the_zip_on_200():
    zip_bytes = _make_zip("BTCUSDT", "1h", "2024-01-01", HEADERLESS_ROW)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=zip_bytes)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        result = _fetch_daily_klines(http, "spot", "BTCUSDT", "1h", datetime.date(2024, 1, 1))
    assert result is not None
    assert len(result) == 1


def _ts_ms(date: datetime.date) -> int:
    return int(datetime.datetime(date.year, date.month, date.day, tzinfo=datetime.UTC).timestamp() * 1000)


def test_backfill_writes_candles_from_scratch_when_none_exist():
    target = BackfillTarget("BTCUSDT.BINANCE.SPOT", "BTCUSDT", "spot")

    def handler(request: httpx.Request) -> httpx.Response:
        # One URL per day; return a one-row zip for every requested date.
        date_str = request.url.path.rsplit("/", 1)[-1].removesuffix(".zip").split("-", 2)[-1]
        date = datetime.date.fromisoformat(date_str)
        row = HEADERLESS_ROW.replace("1704067200000", str(_ts_ms(date)))
        return httpx.Response(200, content=_make_zip("BTCUSDT", "1d", date_str, row))

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        written = backfill_candles_for_target(
            http, target, "1d", today=datetime.date(2020, 1, 5)
        )

    assert written > 0
    df = lake.read_candles("BTCUSDT.BINANCE.SPOT", "1d")
    assert len(df) == written
    assert list(df["ts"]) == sorted(df["ts"])


def test_backfill_resumes_from_the_last_stored_day_not_from_scratch():
    target = BackfillTarget("ETHUSDT.BINANCE.PERP", "ETHUSDT", "futures/um")
    existing = pd.DataFrame(
        {
            "instrument_id": ["ETHUSDT.BINANCE.PERP"],
            "tf": ["1d"],
            "ts": [_ts_ms(datetime.date(2024, 6, 1))],
            "open": [100.0],
            "high": [100.0],
            "low": [100.0],
            "close": [100.0],
            "volume": [1.0],
            "quote_volume": [1.0],
            "taker_buy_volume": [1.0],
            "trades": [1]
        }
    )
    lake.write_parquet("curated/market/candles_1d/ETHUSDT.BINANCE.PERP/data.parquet", existing)

    requested_dates: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        date_str = request.url.path.rsplit("/", 1)[-1].removesuffix(".zip").split("-", 2)[-1]
        requested_dates.append(date_str)
        return httpx.Response(404)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        backfill_candles_for_target(http, target, "1d", today=datetime.date(2024, 6, 5))

    assert requested_dates[0] == "2024-06-02"  # the day after what was already stored


def test_sync_d1_curated_pages_through_and_writes_parquet(tmp_path):
    metrics_rows = [{"_rowid": i, "metric_id": "m", "ts": i, "value": float(i)} for i in range(1, 4)]

    class _FakeClient:
        def get_backup_dump_page(self, table: str, after_rowid: int, limit: int = 2000) -> list[dict]:
            source = metrics_rows if table == "metrics" else []
            return [r for r in source if r["_rowid"] > after_rowid][:limit]

    written = sync_d1_curated(_FakeClient())
    assert written == {
        "metrics": 3,
        "open_interest": 0,
        "funding_rates": 0,
        "long_short_ratios": 0,
        "liquidations_5m": 0,
    }
    df = pd.read_parquet(tmp_path / "curated" / "market" / "metrics" / "data.parquet")
    assert "_rowid" not in df.columns
    assert len(df) == 3


def test_write_snapshot_manifest_is_deterministic_for_the_same_files(tmp_path):
    lake.write_parquet("curated/market/candles_1d/x/data.parquet", pd.DataFrame({"v": [1]}))
    hash1 = write_snapshot_manifest(today="2026-07-05")
    hash2 = write_snapshot_manifest(today="2026-07-06")
    assert hash1 == hash2  # same files -> same fingerprint, regardless of the label

    assert lake.read_bytes("snapshots/latest/dataset_hash.txt").decode() == hash2
    assert (tmp_path / "snapshots" / "2026-07-05" / "manifest.json").exists()
    assert (tmp_path / "snapshots" / "2026-07-06" / "manifest.json").exists()


def test_write_snapshot_manifest_changes_when_a_file_is_added(tmp_path):
    lake.write_parquet("curated/market/candles_1d/x/data.parquet", pd.DataFrame({"v": [1]}))
    hash1 = write_snapshot_manifest(today="2026-07-05")
    lake.write_parquet("curated/market/candles_1d/y/data.parquet", pd.DataFrame({"v": [2]}))
    hash2 = write_snapshot_manifest(today="2026-07-06")
    assert hash1 != hash2


def test_read_dataset_hash_falls_back_to_unknown_before_lake_sync_has_run():
    assert lake.read_dataset_hash() == "unknown"


def test_read_dataset_hash_matches_the_written_manifest():
    written_hash = write_snapshot_manifest(today="2026-07-05")
    assert lake.read_dataset_hash() == written_hash
