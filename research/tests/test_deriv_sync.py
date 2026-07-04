"""jobs/deriv_sync.py (2026-07 design audit TASK-3). Same conventions as
test_lake_sync.py: HTTP faked via httpx.MockTransport, R2 faked via
io/lake.py's local-filesystem branch, no real network access."""

from __future__ import annotations

import datetime
import io
import zipfile

import httpx
import pandas as pd
import pytest

from cryptoedge_research.io import lake
from cryptoedge_research.io.internal_client import FundingRateInput, LiquidationInput, OpenInterestInput
from cryptoedge_research.jobs.deriv_sync import (
    _coerce_ts_ms,
    _funding_zip_url,
    _liquidation_zip_url,
    _metrics_zip_url,
    _parse_funding_csv,
    _parse_liquidation_csv,
    _parse_metrics_csv,
    _to_funding_rows,
    _to_liquidation_rows,
    _to_long_short_ratio_rows,
    _to_oi_rows,
    _watermark_date,
    backfill_deriv_metrics_for_target,
    backfill_funding_for_target,
    backfill_liquidations_for_target,
)
from cryptoedge_research.jobs.lake_sync import BackfillTarget

FUNDING_ROW = "1704067200000,8,0.0001"
METRICS_ROW_EPOCH = "1704067200000,BTCUSDT,50000.5,2000000000.0,1.2,1.5,1.8,1.1"
METRICS_ROW_DATETIME = "2024-01-01 00:00:00,BTCUSDT,50000.5,2000000000.0,1.2,1.5,1.8,1.1"
LIQUIDATION_ROW_LONG = "1704067200000,BTCUSDT,SELL,LIMIT,IOC,0.5,42000.0,42000.0,FILLED,0.5,0.5"
LIQUIDATION_ROW_SHORT = "1704067200000,BTCUSDT,BUY,LIMIT,IOC,1.0,42000.0,42000.0,FILLED,1.0,1.0"


def _make_zip(inner_name: str, csv_text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(inner_name, csv_text)
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _local_lake(tmp_path, monkeypatch):
    monkeypatch.setenv("CRYPTOEDGE_LAKE_LOCAL_PATH", str(tmp_path))
    return tmp_path


class _FakeClient:
    def __init__(self):
        self.funding_rates: list[FundingRateInput] = []
        self.open_interest: list[OpenInterestInput] = []
        self.long_short_ratios = []
        self.liquidations: list[LiquidationInput] = []

    def submit_funding_rates(self, rows):
        self.funding_rates.extend(rows)
        return len(rows)

    def submit_deriv_metrics(self, open_interest, long_short_ratios):
        self.open_interest.extend(open_interest)
        self.long_short_ratios.extend(long_short_ratios)
        return len(open_interest) + len(long_short_ratios)

    def submit_liquidations(self, rows):
        self.liquidations.extend(rows)
        return len(rows)


def test_funding_zip_url_matches_monthly_layout():
    url = _funding_zip_url("BTCUSDT", 2024, 1)
    assert (
        url
        == "https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2024-01.zip"
    )


def test_metrics_zip_url_matches_daily_layout():
    url = _metrics_zip_url("BTCUSDT", datetime.date(2024, 1, 1))
    assert (
        url
        == "https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2024-01-01.zip"
    )


def test_liquidation_zip_url_matches_daily_layout():
    url = _liquidation_zip_url("BTCUSDT", datetime.date(2024, 1, 1))
    assert url == (
        "https://data.binance.vision/data/futures/um/daily/liquidationSnapshot/BTCUSDT/"
        "BTCUSDT-liquidationSnapshot-2024-01-01.zip"
    )


def test_parse_funding_csv_extracts_calc_time_and_rate():
    df = _parse_funding_csv(FUNDING_ROW.encode())
    assert df.iloc[0]["calc_time"] == 1704067200000
    assert df.iloc[0]["last_funding_rate"] == pytest.approx(0.0001)


def test_to_funding_rows_maps_columns_to_the_funding_rates_schema():
    df = _parse_funding_csv(FUNDING_ROW.encode())
    rows = _to_funding_rows(df, "BTCUSDT.BINANCE.PERP")
    assert rows == [FundingRateInput(instrument_id="BTCUSDT.BINANCE.PERP", ts=1704067200000, rate=0.0001)]


def test_coerce_ts_ms_handles_epoch_values():
    result = _coerce_ts_ms(pd.Series([1704067200000]))
    assert result.iloc[0] == 1704067200000


def test_coerce_ts_ms_handles_datetime_strings():
    result = _coerce_ts_ms(pd.Series(["2024-01-01 00:00:00"]))
    assert result.iloc[0] == 1704067200000


def test_parse_metrics_csv_handles_epoch_create_time():
    df = _parse_metrics_csv(METRICS_ROW_EPOCH.encode())
    assert df.iloc[0]["ts"] == 1704067200000
    assert df.iloc[0]["sum_open_interest"] == pytest.approx(50000.5)


def test_parse_metrics_csv_handles_datetime_create_time():
    df = _parse_metrics_csv(METRICS_ROW_DATETIME.encode())
    assert df.iloc[0]["ts"] == 1704067200000


def test_to_oi_rows_keeps_only_on_the_hour_timestamps():
    df = _parse_metrics_csv(METRICS_ROW_EPOCH.encode())
    off_hour = _parse_metrics_csv(METRICS_ROW_EPOCH.replace("1704067200000", "1704067500000").encode())
    combined = pd.concat([df, off_hour], ignore_index=True)
    rows = _to_oi_rows(combined, "BTCUSDT.BINANCE.PERP")
    assert len(rows) == 1
    assert rows[0].ts == 1704067200000
    assert rows[0].oi_base == pytest.approx(50000.5)


def test_to_long_short_ratio_rows_produces_three_ratio_types():
    df = _parse_metrics_csv(METRICS_ROW_EPOCH.encode())
    rows = _to_long_short_ratio_rows(df, "BTCUSDT.BINANCE.PERP")
    ratio_types = {r.ratio_type for r in rows}
    assert ratio_types == {"top_trader_position", "all_account", "taker_volume"}
    top_trader = next(r for r in rows if r.ratio_type == "top_trader_position")
    assert top_trader.ls_ratio == pytest.approx(1.5)
    assert top_trader.long_ratio == pytest.approx(1.5 / 2.5)
    assert top_trader.short_ratio == pytest.approx(1.0 / 2.5)


def test_parse_liquidation_csv_parses_side_and_notional_inputs():
    df = _parse_liquidation_csv(LIQUIDATION_ROW_LONG.encode())
    assert df.iloc[0]["side"] == "SELL"
    assert df.iloc[0]["average_price"] == pytest.approx(42000.0)


def test_to_liquidation_rows_maps_sell_side_to_long_liq_and_buy_side_to_short_liq():
    raw = f"{LIQUIDATION_ROW_LONG}\n{LIQUIDATION_ROW_SHORT}"
    df = _parse_liquidation_csv(raw.encode())
    rows = _to_liquidation_rows(df, "BTCUSDT.BINANCE.PERP")
    assert len(rows) == 1  # both rows land in the same 5m bucket
    row = rows[0]
    assert row.long_liq_usd == pytest.approx(42000.0 * 0.5)
    assert row.short_liq_usd == pytest.approx(42000.0 * 1.0)
    assert row.events == 2
    assert row.source_id == "binance_data_vision"


def test_to_liquidation_rows_buckets_into_5m_windows():
    later = LIQUIDATION_ROW_LONG.replace("1704067200000", "1704067500000")  # +5m
    raw = f"{LIQUIDATION_ROW_LONG}\n{later}"
    df = _parse_liquidation_csv(raw.encode())
    rows = _to_liquidation_rows(df, "BTCUSDT.BINANCE.PERP")
    assert len(rows) == 2
    assert sorted(r.ts for r in rows) == [1704067200000, 1704067500000]


def test_watermark_date_falls_back_to_default_start_when_nothing_synced():
    assert _watermark_date("funding_rates", "BTCUSDT.BINANCE.PERP") == datetime.date(2019, 9, 8)


def test_watermark_date_resumes_the_day_after_the_latest_synced_ts():
    existing = pd.DataFrame(
        {"instrument_id": ["BTCUSDT.BINANCE.PERP"], "ts": [1704067200000], "rate": [0.0001]}
    )
    lake.write_parquet("curated/market/funding_rates/data.parquet", existing)
    assert _watermark_date("funding_rates", "BTCUSDT.BINANCE.PERP") == datetime.date(2024, 1, 2)


def test_watermark_date_falls_back_to_default_start_for_a_columnless_empty_mirror():
    # jobs.lake_sync.sync_d1_curated mirrors a genuinely empty D1 table
    # (nothing backfilled yet, e.g. because binance.vision's archives
    # don't go back to _DEFAULT_START_DATE) as a columnless parquet --
    # found live, 2026-07: this crashed with KeyError('instrument_id')
    # before _watermark_date guarded against it.
    lake.write_parquet("curated/market/liquidations_5m/data.parquet", pd.DataFrame([]))
    assert _watermark_date("liquidations_5m", "BTCUSDT.BINANCE.PERP") == datetime.date(2019, 9, 8)


def test_backfill_funding_for_target_submits_parsed_rows():
    target = BackfillTarget("BTCUSDT.BINANCE.PERP", "BTCUSDT", "futures/um")

    def handler(request: httpx.Request) -> httpx.Response:
        filename = request.url.path.rsplit("/", 1)[-1].removesuffix(".zip")
        return httpx.Response(200, content=_make_zip(f"{filename}.csv", FUNDING_ROW))

    client = _FakeClient()
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        # Default watermark (no R2 data yet) starts at 2019-09-08 -> with
        # `today` one month later, exactly one month is in range.
        written = backfill_funding_for_target(http, client, target, today=datetime.date(2019, 10, 1))

    assert written == 1
    assert client.funding_rates[0].rate == pytest.approx(0.0001)


def test_backfill_funding_for_target_is_a_noop_once_caught_up():
    target = BackfillTarget("BTCUSDT.BINANCE.PERP", "BTCUSDT", "futures/um")
    existing = pd.DataFrame(
        {"instrument_id": ["BTCUSDT.BINANCE.PERP"], "ts": [1706745600000], "rate": [0.0001]}
    )
    lake.write_parquet("curated/market/funding_rates/data.parquet", existing)  # 2024-02-01

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("should not fetch anything once caught up to `today`")

    client = _FakeClient()
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        written = backfill_funding_for_target(http, client, target, today=datetime.date(2024, 2, 1))
    assert written == 0


def test_backfill_deriv_metrics_for_target_submits_oi_and_ls_rows():
    target = BackfillTarget("BTCUSDT.BINANCE.PERP", "BTCUSDT", "futures/um")

    def handler(request: httpx.Request) -> httpx.Response:
        filename = request.url.path.rsplit("/", 1)[-1].removesuffix(".zip")  # BTCUSDT-metrics-2019-09-08
        date_str = filename.split("-metrics-", 1)[-1]
        row = METRICS_ROW_DATETIME.replace("2024-01-01", date_str)
        return httpx.Response(200, content=_make_zip(f"{filename}.csv", row))

    client = _FakeClient()
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        written = backfill_deriv_metrics_for_target(http, client, target, today=datetime.date(2019, 9, 10))

    assert written > 0
    assert len(client.open_interest) == 2  # 2019-09-08, 2019-09-09
    assert len(client.long_short_ratios) == 2 * 3  # x3 ratio types


def test_backfill_liquidations_for_target_aggregates_and_submits():
    target = BackfillTarget("BTCUSDT.BINANCE.PERP", "BTCUSDT", "futures/um")

    def handler(request: httpx.Request) -> httpx.Response:
        date_str = request.url.path.rsplit("/", 1)[-1].removesuffix(".zip").split("Snapshot-", 1)[-1]
        row = LIQUIDATION_ROW_LONG
        return httpx.Response(200, content=_make_zip(f"BTCUSDT-liquidationSnapshot-{date_str}.csv", row))

    client = _FakeClient()
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        written = backfill_liquidations_for_target(http, client, target, today=datetime.date(2019, 9, 9))

    assert written == 1
    assert client.liquidations[0].long_liq_usd == pytest.approx(42000.0 * 0.5)
