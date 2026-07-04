"""Historical funding-rate / open-interest / long-short-ratio / liquidation
backfill (docs/03 §2.1-2.2/§5, 2026-07 design audit TASK-3).

Live funding/OI come from OKX at 5m cadence (`workers/ingest/src/adapters/
okx.ts`), but that trickle only started in 2026-07 and never covers
history, and long_short_ratios/liquidations_5m have no writer at all yet
(docs/03's V1 design calls for CoinGlass/OKX rubik for those, which aren't
implemented). data.binance.vision publishes years of this as the same
kind of static daily/monthly ZIP archive `jobs/lake_sync.py` already reads
for candles — reachable from GitHub Actions (unlike Binance's rate-limited
REST API, which WAF-blocks Workers' shared egress IPs; docs/03 §2.1), so
this backfills from there instead of waiting on a new live source.

Perpetual futures only (`market_path == "futures/um"`): funding/OI/L-S/
liquidations don't exist for spot.

Three archive types, one instrument-month/day per HTTP request, same
model as `_fetch_daily_klines`:
  - `fundingRate` (monthly): funding settlements, ~3/day -> cheap enough to
    backfill in full without throttling.
  - `metrics` (daily, 5m native cadence): open interest + long/short
    ratios in one file. Downsampled to on-the-hour rows to match the 1h
    candle/feature grid and keep D1 write volume bounded (docs/01 §4.1
    "80K 行/日以下"), throttled `_MAX_DAYS_PER_RUN` days/run like candles.
  - `liquidationSnapshot` (daily, per-order): aggregated into 5m buckets
    (`liquidations_5m`'s native grain) before upserting, same throttling.

Pure library module, no `main()`: called from `jobs/lake_sync.py`'s main()
(deferred import there to avoid a circular import, since this module reads
`BACKFILL_TARGETS`/`BackfillTarget` back from lake_sync), right before that
job mirrors D1 into R2 -- so this module's own watermark lookups
(`_watermark_date`) always see fresh state from the *previous* run.

NOTE: same caveat as `jobs/lake_sync.py` — the actual data.binance.vision
CSV layouts here (fundingRate/metrics/liquidationSnapshot columns) are
based on Binance's documented format, not a fixture captured live; this
sandbox has no outbound network access to verify against the real host.
"""

from __future__ import annotations

import datetime
import io
import logging
import zipfile

import httpx
import pandas as pd

from cryptoedge_research.io import lake
from cryptoedge_research.io.internal_client import (
    FundingRateInput,
    InternalApiClient,
    LiquidationInput,
    LongShortRatioInput,
    OpenInterestInput,
)
from cryptoedge_research.jobs.lake_sync import BACKFILL_TARGETS, BackfillTarget, _normalize_ms

logger = logging.getLogger(__name__)

_DATA_VISION_BASE = "https://data.binance.vision/data"

FUTURES_TARGETS = [t for t in BACKFILL_TARGETS if t.market_path == "futures/um"]

_MAX_DAYS_PER_RUN = 365  # mirrors lake_sync's 1h/1d throttle (docs/01 §4.1)
_MAX_MONTHS_PER_RUN = 24  # funding settles ~3x/day; cheap enough to move faster

_DEFAULT_START_DATE = "2019-09-08"  # docs/03 §5 "funding 2019-09〜"; futures/um listing date

_HOUR_MS = 3_600_000
_FIVE_MIN_MS = 300_000

_FUNDING_COLUMNS = ["calc_time", "funding_interval_hours", "last_funding_rate"]
_METRICS_COLUMNS = [
    "create_time",
    "symbol",
    "sum_open_interest",
    "sum_open_interest_value",
    "count_toptrader_long_short_ratio",
    "sum_toptrader_long_short_ratio",
    "count_long_short_ratio",
    "sum_taker_long_short_vol_ratio",
]
_LIQUIDATION_COLUMNS = [
    "time",
    "symbol",
    "side",
    "order_type",
    "time_in_force",
    "original_quantity",
    "price",
    "average_price",
    "order_status",
    "last_fill_quantity",
    "accumulated_fill_quantity",
]

# (ratio_type, source column) -- both metrics.csv long/short ratio columns
# that are meaningfully distinct signals (docs/03 §1 "レバレッジ構造系").
# count_toptrader_long_short_ratio is dropped: near-redundant with
# sum_toptrader_long_short_ratio (account-count vs position-size ratio for
# the same top-trader cohort) and not worth a 4th series.
_RATIO_COLUMNS = [
    ("top_trader_position", "sum_toptrader_long_short_ratio"),
    ("all_account", "count_long_short_ratio"),
    ("taker_volume", "sum_taker_long_short_vol_ratio"),
]


def _funding_zip_url(symbol: str, year: int, month: int) -> str:
    yyyymm = f"{year:04d}-{month:02d}"
    return f"{_DATA_VISION_BASE}/futures/um/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{yyyymm}.zip"


def _metrics_zip_url(symbol: str, date: datetime.date) -> str:
    return f"{_DATA_VISION_BASE}/futures/um/daily/metrics/{symbol}/{symbol}-metrics-{date.isoformat()}.zip"


def _liquidation_zip_url(symbol: str, date: datetime.date) -> str:
    return (
        f"{_DATA_VISION_BASE}/futures/um/daily/liquidationSnapshot/{symbol}/"
        f"{symbol}-liquidationSnapshot-{date.isoformat()}.zip"
    )


def _fetch_zip_member(http: httpx.Client, url: str, inner_name: str) -> bytes | None:
    """Returns the named member's raw bytes, or `None` for a 404 (no
    archive published for that period) -- same shape as
    lake_sync._fetch_daily_klines."""
    res = http.get(url)
    if res.status_code == 404:
        return None
    res.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        with zf.open(inner_name) as f:
            return f.read()


def _drop_inline_header_row(df: pd.DataFrame, first_column: str) -> pd.DataFrame:
    # Same header-row quirk as klines CSVs (lake_sync._parse_klines_csv):
    # some date ranges ship an actual header row inline with header=None.
    if str(df.iloc[0][first_column]).strip().lower() == first_column:
        return df.iloc[1:].reset_index(drop=True)
    return df


def _coerce_ts_ms(raw: pd.Series) -> pd.Series:
    """create_time in binance.vision's `metrics` files is sometimes an
    epoch and sometimes a "YYYY-MM-DD HH:MM:SS" string depending on
    date/symbol; handle both rather than assuming one."""
    numeric = pd.to_numeric(raw, errors="coerce")
    if numeric.notna().all():
        return _normalize_ms(numeric)
    # pandas infers datetime64 resolution from the string's precision (e.g.
    # "us" for whole-second strings, not always "ns"), so a bare
    # .astype("int64") would silently return the wrong unit; casting to an
    # explicit ms resolution first sidesteps that.
    return pd.to_datetime(raw, utc=True).astype("datetime64[ms, UTC]").astype("int64")


def _parse_funding_csv(raw: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), header=None, names=_FUNDING_COLUMNS)
    df = _drop_inline_header_row(df, "calc_time")
    df["calc_time"] = _normalize_ms(pd.to_numeric(df["calc_time"]))
    df["last_funding_rate"] = pd.to_numeric(df["last_funding_rate"])
    return df


def _parse_metrics_csv(raw: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), header=None, names=_METRICS_COLUMNS)
    df = _drop_inline_header_row(df, "create_time")
    df["ts"] = _coerce_ts_ms(df["create_time"])
    for col in _METRICS_COLUMNS[2:]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def _parse_liquidation_csv(raw: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), header=None, names=_LIQUIDATION_COLUMNS)
    df = _drop_inline_header_row(df, "time")
    df["time"] = _normalize_ms(pd.to_numeric(df["time"]))
    numeric_cols = (
        "original_quantity",
        "price",
        "average_price",
        "last_fill_quantity",
        "accumulated_fill_quantity",
    )
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def _to_funding_rows(df: pd.DataFrame, instrument_id: str) -> list[FundingRateInput]:
    return [
        FundingRateInput(
            instrument_id=instrument_id, ts=int(row["calc_time"]), rate=float(row["last_funding_rate"])
        )
        for _, row in df.iterrows()
    ]


def _to_oi_rows(df: pd.DataFrame, instrument_id: str) -> list[OpenInterestInput]:
    hourly = df[df["ts"] % _HOUR_MS == 0]
    return [
        OpenInterestInput(
            instrument_id=instrument_id,
            ts=int(row["ts"]),
            oi_base=float(row["sum_open_interest"]),
            oi_usd=float(row["sum_open_interest_value"]),
        )
        for _, row in hourly.iterrows()
    ]


def _to_long_short_ratio_rows(df: pd.DataFrame, instrument_id: str) -> list[LongShortRatioInput]:
    hourly = df[df["ts"] % _HOUR_MS == 0]
    rows: list[LongShortRatioInput] = []
    for ratio_type, col in _RATIO_COLUMNS:
        for _, row in hourly.iterrows():
            ratio = row[col]
            if pd.isna(ratio) or ratio < 0:
                continue
            rows.append(
                LongShortRatioInput(
                    instrument_id=instrument_id,
                    ratio_type=ratio_type,
                    ts=int(row["ts"]),
                    long_ratio=float(ratio / (1.0 + ratio)),
                    short_ratio=float(1.0 / (1.0 + ratio)),
                    ls_ratio=float(ratio),
                )
            )
    return rows


def _to_liquidation_rows(df: pd.DataFrame, instrument_id: str) -> list[LiquidationInput]:
    if len(df) == 0:
        return []
    working = df.copy()
    working["bucket_ts"] = (working["time"] // _FIVE_MIN_MS) * _FIVE_MIN_MS
    fallback_notional = working["price"] * working["original_quantity"]
    executed_notional = working["average_price"] * working["last_fill_quantity"]
    working["notional"] = executed_notional.where(executed_notional > 0, fallback_notional)

    rows: list[LiquidationInput] = []
    for bucket_ts, group in working.groupby("bucket_ts"):
        long_liq = float(group.loc[group["side"] == "SELL", "notional"].sum())
        short_liq = float(group.loc[group["side"] == "BUY", "notional"].sum())
        rows.append(
            LiquidationInput(
                instrument_id=instrument_id,
                ts=int(bucket_ts),
                long_liq_usd=long_liq,
                short_liq_usd=short_liq,
                events=int(len(group)),
                max_single_usd=float(group["notional"].max()),
                source_id="binance_data_vision",
            )
        )
    return rows


def _month_range(start: datetime.date, end_exclusive: datetime.date) -> list[tuple[int, int]]:
    months: list[tuple[int, int]] = []
    year, month = start.year, start.month
    while (year, month) < (end_exclusive.year, end_exclusive.month):
        months.append((year, month))
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return months


def _watermark_date(curated_table: str, instrument_id: str, source_id: str | None = None) -> datetime.date:
    """The day after the latest `ts` already mirrored to R2 for this
    instrument (`jobs.lake_sync.sync_d1_curated` writes that mirror every
    run, right after this module's own backfill runs), or
    `_DEFAULT_START_DATE` if nothing's landed yet. Reads R2, not D1
    directly -- research-worker never touches D1 directly (docs/01 §5)."""
    try:
        df = lake.read_parquet(f"curated/market/{curated_table}/data.parquet")
    except OSError:
        return datetime.date.fromisoformat(_DEFAULT_START_DATE)
    df = df[df["instrument_id"] == instrument_id]
    if source_id is not None:
        df = df[df["source_id"] == source_id]
    if len(df) == 0:
        return datetime.date.fromisoformat(_DEFAULT_START_DATE)
    last_ts = int(df["ts"].max())
    last_date = datetime.datetime.fromtimestamp(last_ts / 1000, tz=datetime.UTC).date()
    return last_date + datetime.timedelta(days=1)


def backfill_funding_for_target(
    http: httpx.Client, client: InternalApiClient, target: BackfillTarget, today: datetime.date | None = None
) -> int:
    today = today or datetime.datetime.now(tz=datetime.UTC).date()
    start = _watermark_date("funding_rates", target.instrument_id)
    if start >= today:
        return 0
    months = _month_range(start.replace(day=1), today)[:_MAX_MONTHS_PER_RUN]

    rows: list[FundingRateInput] = []
    for year, month in months:
        url = _funding_zip_url(target.binance_symbol, year, month)
        inner_name = f"{target.binance_symbol}-fundingRate-{year:04d}-{month:02d}.csv"
        raw = _fetch_zip_member(http, url, inner_name)
        if raw is None:
            continue
        df = _parse_funding_csv(raw)
        rows.extend(_to_funding_rows(df, target.instrument_id))

    if not rows:
        return 0
    written = client.submit_funding_rates(rows)
    logger.info("backfilled %d funding_rate row(s) for %s", written, target.instrument_id)
    return written


def backfill_deriv_metrics_for_target(
    http: httpx.Client, client: InternalApiClient, target: BackfillTarget, today: datetime.date | None = None
) -> int:
    today = today or datetime.datetime.now(tz=datetime.UTC).date()
    start = _watermark_date("open_interest", target.instrument_id)
    if start >= today:
        return 0
    end = min(today, start + datetime.timedelta(days=_MAX_DAYS_PER_RUN))

    oi_rows: list[OpenInterestInput] = []
    ls_rows: list[LongShortRatioInput] = []
    date = start
    while date < end:
        url = _metrics_zip_url(target.binance_symbol, date)
        raw = _fetch_zip_member(http, url, f"{target.binance_symbol}-metrics-{date.isoformat()}.csv")
        if raw is not None:
            df = _parse_metrics_csv(raw)
            oi_rows.extend(_to_oi_rows(df, target.instrument_id))
            ls_rows.extend(_to_long_short_ratio_rows(df, target.instrument_id))
        date += datetime.timedelta(days=1)

    if not oi_rows and not ls_rows:
        return 0
    written = client.submit_deriv_metrics(oi_rows, ls_rows)
    logger.info("backfilled %d open_interest/long_short_ratio row(s) for %s", written, target.instrument_id)
    return written


def backfill_liquidations_for_target(
    http: httpx.Client, client: InternalApiClient, target: BackfillTarget, today: datetime.date | None = None
) -> int:
    today = today or datetime.datetime.now(tz=datetime.UTC).date()
    start = _watermark_date("liquidations_5m", target.instrument_id, source_id="binance_data_vision")
    if start >= today:
        return 0
    end = min(today, start + datetime.timedelta(days=_MAX_DAYS_PER_RUN))

    rows: list[LiquidationInput] = []
    date = start
    while date < end:
        url = _liquidation_zip_url(target.binance_symbol, date)
        inner_name = f"{target.binance_symbol}-liquidationSnapshot-{date.isoformat()}.csv"
        raw = _fetch_zip_member(http, url, inner_name)
        if raw is not None:
            df = _parse_liquidation_csv(raw)
            rows.extend(_to_liquidation_rows(df, target.instrument_id))
        date += datetime.timedelta(days=1)

    if not rows:
        return 0
    written = client.submit_liquidations(rows)
    logger.info("backfilled %d liquidation bucket(s) for %s", written, target.instrument_id)
    return written
