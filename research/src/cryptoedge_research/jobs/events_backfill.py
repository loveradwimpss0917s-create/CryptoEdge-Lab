"""Historical event backfill (docs/17 ADR-1, docs/19 S-03): `events` was
forward-collect-only (each live ingest adapter only ever writes the event
it just detected), so every event-referencing signal_spec had zero
historical samples to evaluate against -- the direct blocker for the
remaining P0 seed edges (cme-gap-fill, usdt-mint-drift) docs/18 V1-3 waits
on. Three sources, each reusing the exact parsing/detection logic and
dedupe_key convention its live TypeScript adapter already established
(`workers/ingest/src/adapters/{yahoo-finance,etherscan}.ts`), so a
backfilled row and a later live-collected row for the same real-world
event collide via `ON CONFLICT (dedupe_key) DO NOTHING` instead of
duplicating:

1. `backfill_cme_gap`: Yahoo Finance BTC=F full daily history -- same
   >=2-calendar-day-gap detection as yahoo-finance.ts's `computeCmeGap`,
   applied across the whole series instead of just the latest two bars.
2. `backfill_usdt_mint`: Etherscan's Tether Treasury transfer history,
   paginated -- same "Transfer from the zero address = mint" filter as
   etherscan.ts's `parseUsdtMints`.
3. `backfill_fomc`: intentionally NOT implemented with hardcoded dates.
   FOMC_HISTORICAL_DATES below ships EMPTY -- see its own docstring for
   why (mirrors workers/ingest/src/adapters/econ-calendar.ts's identical
   policy for the exact same reason).

NOTE: same caveat as `jobs/lake_sync.py` and `jobs/deriv_sync.py` -- the
Yahoo Finance chart API and Etherscan `tokentx` response shapes here are
based on documented/widely-used formats, not fixtures captured live (no
outbound network access to query1.finance.yahoo.com or api.etherscan.io
from this sandbox). Re-verify against a real response before the first
production run if either source has changed its contract.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import httpx

from cryptoedge_research.io.internal_client import EventInput, InternalApiClient

logger = logging.getLogger(__name__)

_MS_PER_DAY = 86_400_000
_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

# Mirrors workers/ingest/src/adapters/etherscan.ts's USDT_TREASURY_ADDRESS
# exactly (same unverified-from-training-knowledge caveat noted there) --
# already the address that live production traffic writes usdt_mint events
# against, so reusing it here introduces no new risk versus what's already
# shipped.
USDT_TREASURY_ADDRESS = "0x5754284f345afc66a98fbb0a0afe71e0f007b9d"


# ---------------------------------------------------------------------------
# cme_gap (Yahoo Finance BTC=F daily history)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DailyBar:
    ts: int
    open: float
    close: float


def parse_yahoo_daily_bars(resp: dict) -> list[DailyBar]:
    """Mirrors yahoo-finance.ts's `parseYahooDailyBars` -- drops any bar
    with a null open/close (Yahoo pads the arrays with nulls for the
    still-forming current-day bar and any data gaps)."""
    result = (resp.get("chart") or {}).get("result") or []
    if not result:
        return []
    quote = (result[0].get("indicators") or {}).get("quote") or []
    if not quote:
        return []
    timestamps = result[0].get("timestamp") or []
    opens = quote[0].get("open") or []
    closes = quote[0].get("close") or []
    bars: list[DailyBar] = []
    for i, ts in enumerate(timestamps):
        o, c = opens[i], closes[i]
        if o is None or c is None:
            continue
        bars.append(DailyBar(ts=ts * 1000, open=o, close=c))
    return bars


def compute_cme_gap_history(bars: list[DailyBar]) -> list[EventInput]:
    """Mirrors yahoo-finance.ts's `computeCmeGap`, but applied across every
    consecutive pair in the series (that adapter only ever looks at the
    latest two bars, since it runs once/day going forward -- backfill needs
    every historical transition at once)."""
    events: list[EventInput] = []
    for prev, curr in zip(bars, bars[1:], strict=False):
        gap_days = round((curr.ts - prev.ts) / _MS_PER_DAY)
        if gap_days < 2:
            continue
        magnitude_pct = (curr.open - prev.close) / prev.close * 100
        date_key = time.strftime("%Y-%m-%d", time.gmtime(curr.ts / 1000))
        events.append(
            EventInput(
                event_type="cme_gap",
                ts=curr.ts,
                magnitude=abs(magnitude_pct),
                payload={"magnitude_pct": magnitude_pct, "gap_days": gap_days},
                source_id="events_backfill",
                dedupe_key=f"cme_gap:{date_key}",
            )
        )
    return events


def backfill_cme_gap(http: httpx.Client, start: str = "2019-01-01") -> list[EventInput]:
    """Fetches BTC=F's full daily history from `start` to now via explicit
    period1/period2 (Yahoo's chart API alternative to yahoo-finance.ts's
    `range=10d` -- same endpoint, wider window)."""
    period1 = int(time.mktime(time.strptime(start, "%Y-%m-%d")))
    period2 = int(time.time())
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/BTC=F"
        f"?period1={period1}&period2={period2}&interval=1d"
    )
    res = http.get(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json",
        },
    )
    res.raise_for_status()
    bars = parse_yahoo_daily_bars(res.json())
    return compute_cme_gap_history(bars)


# ---------------------------------------------------------------------------
# usdt_mint (Etherscan Tether Treasury transfer history)
# ---------------------------------------------------------------------------


def parse_usdt_mints(resp: dict) -> list[EventInput]:
    """Mirrors etherscan.ts's `parseUsdtMints` -- a `Transfer` from the
    zero address is an ERC-20 mint (new supply), not a transfer of
    existing tokens."""
    if resp.get("status") != "1":
        return []
    events: list[EventInput] = []
    for tx in resp.get("result") or []:
        if tx["from"].lower() != _ZERO_ADDRESS:
            continue
        amount_usd = int(tx["value"]) / 10 ** int(tx["tokenDecimal"])
        events.append(
            EventInput(
                event_type="usdt_mint",
                ts=int(tx["timeStamp"]) * 1000,
                magnitude=amount_usd,
                payload={"tx_hash": tx["hash"]},
                source_id="events_backfill",
                dedupe_key=f"usdt_mint:{tx['hash']}",
            )
        )
    return events


_ETHERSCAN_PAGE_SIZE = 1000
_MAX_ETHERSCAN_PAGES = 20  # 20k txs is far more than USDT_TREASURY_ADDRESS has ever seen


def backfill_usdt_mint(http: httpx.Client, api_key: str) -> list[EventInput]:
    """Pages through the Treasury address's full ERC-20 transfer history
    (Etherscan's free tier caps a single page at 10k rows; paginating in
    1k-row pages keeps each request small and cheap to retry)."""
    events: list[EventInput] = []
    for page in range(1, _MAX_ETHERSCAN_PAGES + 1):
        url = (
            "https://api.etherscan.io/api?module=account&action=tokentx"
            f"&address={USDT_TREASURY_ADDRESS}&sort=asc&page={page}&offset={_ETHERSCAN_PAGE_SIZE}"
            f"&apikey={api_key}"
        )
        res = http.get(url)
        res.raise_for_status()
        body = res.json()
        page_events = parse_usdt_mints(body)
        events.extend(page_events)
        if len(body.get("result") or []) < _ETHERSCAN_PAGE_SIZE:
            break
    return events


# ---------------------------------------------------------------------------
# fomc -- NOT implemented with hardcoded dates, see docstring
# ---------------------------------------------------------------------------

# IMPORTANT: ships EMPTY, same as workers/ingest/src/adapters/econ-calendar.ts's
# ECON_CALENDAR and for the identical reason -- this deliberately does not
# fabricate historical FOMC meeting dates from training knowledge, since a
# wrong date silently corrupts every event-referencing signal_spec's
# evaluation rather than failing loudly. docs/19 S-03's own design expects
# this list to come from federalreserve.gov's per-year historical pages
# (federalreserve.gov/monetarypolicy/fomchistorical{YYYY}.htm), which this
# sandbox cannot reach to verify (network to that host is blocked here,
# same restriction the docs/19 card itself calls out -- "federalreserve.gov
# は research-worker (GitHub Actions) からは到達可能" implies GitHub
# Actions' real network access, not this authoring session). Populate this
# list (format: "YYYY-MM-DD", the decision/announcement day -- day 2 of
# each 2-day meeting) from that source, or paste a verified list from the
# user, before running backfill_fomc() for the first time.
FOMC_HISTORICAL_DATES: list[str] = []


def backfill_fomc() -> list[EventInput]:
    return [
        EventInput(
            event_type="fomc",
            ts=int(time.mktime(time.strptime(date, "%Y-%m-%d"))) * 1000,
            source_id="events_backfill",
            dedupe_key=f"fomc:{date}",
        )
        for date in FOMC_HISTORICAL_DATES
    ]


def main() -> int:
    import os

    logging.basicConfig(level=logging.INFO)
    base_url = os.environ["CRYPTOEDGE_API_URL"]
    token = os.environ["RESEARCH_API_TOKEN"]
    etherscan_key = os.environ.get("ETHERSCAN_API_KEY")

    with httpx.Client(timeout=30.0) as http, InternalApiClient(base_url, token) as client:
        cme_gap_events = backfill_cme_gap(http)
        written = client.submit_events(cme_gap_events) if cme_gap_events else 0
        logger.info("cme_gap: %d candidate event(s), %d newly written", len(cme_gap_events), written)

        if etherscan_key:
            usdt_events = backfill_usdt_mint(http, etherscan_key)
            written = client.submit_events(usdt_events) if usdt_events else 0
            logger.info("usdt_mint: %d candidate event(s), %d newly written", len(usdt_events), written)
        else:
            logger.info("usdt_mint: skipped, ETHERSCAN_API_KEY not configured")

        fomc_events = backfill_fomc()
        if fomc_events:
            written = client.submit_events(fomc_events)
            logger.info("fomc: %d candidate event(s), %d newly written", len(fomc_events), written)
        else:
            logger.info("fomc: skipped, FOMC_HISTORICAL_DATES is empty (see module docstring)")

    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
