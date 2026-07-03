"""io/lake.py's R2-config helpers (2026-07: found live, against real R2,
that pyarrow's endpoint_override must not include a scheme — see
_split_scheme's docstring for the exact failure this guards against)."""

from __future__ import annotations

import pandas as pd
import pytest

from cryptoedge_research.io import lake
from cryptoedge_research.io.lake import _r2_config, _split_scheme


def test_split_scheme_strips_https_prefix():
    assert _split_scheme("https://abc123.r2.cloudflarestorage.com") == (
        "https",
        "abc123.r2.cloudflarestorage.com"
    )


def test_split_scheme_defaults_to_https_when_no_scheme_present():
    assert _split_scheme("abc123.r2.cloudflarestorage.com") == ("https", "abc123.r2.cloudflarestorage.com")


def test_r2_config_raises_a_clear_error_when_unset(monkeypatch):
    monkeypatch.delenv("CRYPTOEDGE_R2_ENDPOINT", raising=False)
    monkeypatch.delenv("CRYPTOEDGE_R2_BUCKET", raising=False)
    with pytest.raises(RuntimeError, match="CRYPTOEDGE_R2_ENDPOINT"):
        _r2_config()


def test_r2_config_raises_a_clear_error_when_empty_string(monkeypatch):
    # A GitHub Actions secret referenced but never configured resolves to
    # an empty string, not a missing env var — this is the actual failure
    # mode that mattered in production.
    monkeypatch.setenv("CRYPTOEDGE_R2_ENDPOINT", "")
    monkeypatch.setenv("CRYPTOEDGE_R2_BUCKET", "cryptoedge-lake")
    with pytest.raises(RuntimeError, match="CRYPTOEDGE_R2_ENDPOINT"):
        _r2_config()


def test_r2_config_returns_both_values_when_set(monkeypatch):
    monkeypatch.setenv("CRYPTOEDGE_R2_ENDPOINT", "https://abc123.r2.cloudflarestorage.com")
    monkeypatch.setenv("CRYPTOEDGE_R2_BUCKET", "cryptoedge-lake")
    assert _r2_config() == ("https://abc123.r2.cloudflarestorage.com", "cryptoedge-lake")


def test_read_candles_normalizes_microsecond_scale_ts_back_to_milliseconds(tmp_path, monkeypatch):
    # Found live: Binance's kline CSVs switched some symbols/dates to
    # microsecond-precision open_time in 2025, and a from-scratch backfill
    # spanning old (ms) and new (us) dates wrote a mixed-scale `ts` column
    # to R2 before jobs/lake_sync.py started normalizing at parse time.
    # read_candles self-heals any already-written bad rows so every
    # consumer (backfill resume logic, EEP evaluation, verdicts) sees
    # correct milliseconds regardless of when the row was written.
    monkeypatch.setenv("CRYPTOEDGE_LAKE_LOCAL_PATH", str(tmp_path))
    ms_row_ts = 1_700_000_000_000  # a normal 2023-ish millisecond timestamp
    us_row_ts = 1_783_000_000_000_000  # the same row mistakenly in microseconds
    df = pd.DataFrame(
        {
            "instrument_id": ["BTCUSDT.BINANCE.SPOT", "BTCUSDT.BINANCE.SPOT"],
            "tf": ["1d", "1d"],
            "ts": [ms_row_ts, us_row_ts],
            "open": [1.0, 1.0],
            "high": [1.0, 1.0],
            "low": [1.0, 1.0],
            "close": [1.0, 1.0],
            "volume": [1.0, 1.0],
            "quote_volume": [1.0, 1.0],
            "taker_buy_volume": [1.0, 1.0],
            "trades": [1, 1]
        }
    )
    lake.write_parquet("curated/market/candles_1d/BTCUSDT.BINANCE.SPOT/data.parquet", df)

    result = lake.read_candles("BTCUSDT.BINANCE.SPOT", "1d")
    assert list(result["ts"]) == [ms_row_ts, us_row_ts // 1000]
