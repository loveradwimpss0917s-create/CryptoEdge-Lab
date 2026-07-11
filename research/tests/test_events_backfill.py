"""jobs/events_backfill.py (docs/17 ADR-1, docs/19 S-03). Pure-logic
functions exercised with fixtures; HTTP-fetching wrappers exercised via
httpx.MockTransport (no real network access in this sandbox), same
convention as test_lake_sync.py / test_deriv_sync.py."""

from __future__ import annotations

import httpx

from cryptoedge_research.jobs.events_backfill import (
    DailyBar,
    backfill_cme_gap,
    backfill_fomc,
    backfill_usdt_mint,
    compute_cme_gap_history,
    parse_usdt_mints,
    parse_yahoo_daily_bars,
)

DAY = 86_400_000


def _yahoo_chart(timestamps: list[int], opens: list[float | None], closes: list[float | None]) -> dict:
    quote = {"open": opens, "close": closes}
    return {"chart": {"result": [{"timestamp": timestamps, "indicators": {"quote": [quote]}}]}}


def test_parse_yahoo_daily_bars_drops_null_rows():
    bars = parse_yahoo_daily_bars(_yahoo_chart([100, 200, 300], [10, 20, None], [11, 21, None]))
    assert bars == [DailyBar(ts=100_000, open=10, close=11), DailyBar(ts=200_000, open=20, close=21)]


def test_parse_yahoo_daily_bars_empty_result():
    assert parse_yahoo_daily_bars({"chart": {"result": None}}) == []


def test_compute_cme_gap_history_finds_every_weekend_gap_in_the_series():
    # Friday close -> Monday open (3 calendar days) three separate weeks,
    # interleaved with ordinary consecutive trading days.
    bars = [
        DailyBar(ts=0, open=100, close=100),
        DailyBar(ts=3 * DAY, open=105, close=106),  # gap #1
        DailyBar(ts=4 * DAY, open=106, close=107),  # no gap
        DailyBar(ts=7 * DAY, open=110, close=111),  # gap #2
    ]
    events = compute_cme_gap_history(bars)
    assert len(events) == 2
    assert events[0].dedupe_key == "cme_gap:1970-01-04"
    assert events[0].payload["gap_days"] == 3
    assert events[0].magnitude == abs((105 - 100) / 100 * 100)
    assert events[1].dedupe_key == "cme_gap:1970-01-08"


def test_compute_cme_gap_history_no_gaps_in_consecutive_days():
    bars = [DailyBar(ts=0, open=100, close=101), DailyBar(ts=DAY, open=101, close=102)]
    assert compute_cme_gap_history(bars) == []


def test_backfill_cme_gap_sends_browser_headers_and_full_range():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        captured["url"] = str(request.url)
        return httpx.Response(200, json=_yahoo_chart([0, 3 * 86_400], [100, 105], [100, 106]))

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        events = backfill_cme_gap(http, start="2019-01-01")

    assert "query1.finance.yahoo.com" in captured["url"]
    assert "period1=" in captured["url"] and "period2=" in captured["url"]
    assert "Mozilla" in captured["headers"]["user-agent"]
    assert len(events) == 1
    assert events[0].event_type == "cme_gap"


def test_parse_usdt_mints_filters_transfers_from_zero_address():
    resp = {
        "status": "1",
        "result": [
            {
                "hash": "0xabc",
                "timeStamp": "1546560000",
                "from": "0x0000000000000000000000000000000000000000",
                "to": "0xsomeone",
                "value": "1000000000000000",
                "tokenDecimal": "6",
            },
            {
                "hash": "0xdef",
                "timeStamp": "1546560100",
                "from": "0xnotzero",
                "to": "0xsomeone",
                "value": "500000000",
                "tokenDecimal": "6",
            },
        ],
    }
    events = parse_usdt_mints(resp)
    assert len(events) == 1
    assert events[0].dedupe_key == "usdt_mint:0xabc"
    assert events[0].magnitude == 1_000_000_000.0
    assert events[0].ts == 1546560000000


def test_parse_usdt_mints_empty_on_error_status():
    assert parse_usdt_mints({"status": "0", "result": []}) == []


def test_backfill_usdt_mint_stops_paginating_below_a_full_page():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            200,
            json={
                "status": "1",
                "result": [
                    {
                        "hash": "0xabc",
                        "timeStamp": "1546560000",
                        "from": "0x0000000000000000000000000000000000000000",
                        "to": "0xsomeone",
                        "value": "1000000",
                        "tokenDecimal": "6",
                    }
                ],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        events = backfill_usdt_mint(http, api_key="test-key")

    assert len(calls) == 1  # first page returned fewer than a full page -> stop
    assert "apikey=test-key" in calls[0]
    assert len(events) == 1


def test_backfill_fomc_returns_empty_list_since_dates_are_unpopulated():
    # docs/19 S-03: FOMC_HISTORICAL_DATES intentionally ships empty (see
    # events_backfill.py's module docstring) -- this must stay a documented
    # no-op, not silently fabricate dates.
    assert backfill_fomc() == []
