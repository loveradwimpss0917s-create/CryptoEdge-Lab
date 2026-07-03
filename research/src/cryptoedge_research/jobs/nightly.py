"""Daily-light job (docs/01 §3.2 `research-daily`, docs/09 Phase 2).

V1/Phase 2 scope: recompute today's rule-based regime label (docs/04 §6)
and submit it. The remaining daily-light responsibilities from docs/09
(§4 CUSUM decay checks against ACTIVE/PAPER Edges, Research Pack
generation) depend on paper_signals volume and the AI-handoff Pack
templates (docs/07) respectively, and are intentionally left as follow-up
work rather than stubbed out here with fabricated behavior.
"""

from __future__ import annotations

import datetime
import logging
import os
import sys

import pandas as pd

from cryptoedge_research.io.internal_client import InternalApiClient, RegimeUpdateInput
from cryptoedge_research.io.lake import read_candles
from cryptoedge_research.regimes.rule_based import classify_regime

logger = logging.getLogger(__name__)

REGIME_MODEL_VERSION = "rule-based-1.0"

_MIN_HISTORY_ROWS = 200


def _classify_daily(daily: pd.DataFrame) -> pd.DataFrame:
    zeros = daily["close"] * 0.0  # placeholder liquidity inputs until those series are ingested (docs/03)
    return classify_regime(
        close=daily["close"],
        high=daily.get("high", daily["close"]),
        low=daily.get("low", daily["close"]),
        spread_bps=zeros,
        liq_zscore=zeros,
        peg_dev_bps=zeros,
    )


def _dt_str(ts_ms: int) -> str:
    return datetime.datetime.fromtimestamp(ts_ms / 1000, tz=datetime.UTC).strftime("%Y-%m-%d")


def compute_regime_history(instrument_id: str = "BTCUSDT.BINANCE.PERP") -> list[RegimeUpdateInput]:
    """Classifies every day with enough trailing history, not just the
    latest one — used by the R2 lake-writer's historical backfill
    (2026-07 review, Task 4) so `regimes_daily` isn't empty for every date
    before the day this job first ran."""
    daily = read_candles(instrument_id, "1d")
    if len(daily) < _MIN_HISTORY_ROWS:
        logger.warning("not enough daily history (%d rows) to classify any regime yet", len(daily))
        return []

    labels = _classify_daily(daily)
    updates: list[RegimeUpdateInput] = []
    for i in range(len(labels)):
        row = labels.iloc[i]
        if row.isna().any():
            continue
        updates.append(
            RegimeUpdateInput(
                dt=_dt_str(daily["ts"].iloc[i]),
                trend=row["trend"],
                vol=row["vol"],
                liquidity=row["liquidity"],
                model_version=REGIME_MODEL_VERSION,
            )
        )
    return updates


def compute_today_regime(instrument_id: str = "BTCUSDT.BINANCE.PERP") -> RegimeUpdateInput | None:
    """Unlike `compute_regime_history`, an incomplete *latest* row means
    "nothing to report today" (None) rather than being silently skipped —
    the nightly job should stay quiet on a day it can't classify, not
    fall back to reporting a stale earlier day as if it were today."""
    daily = read_candles(instrument_id, "1d")
    if len(daily) < _MIN_HISTORY_ROWS:
        logger.warning("not enough daily history (%d rows) to classify a regime yet", len(daily))
        return None

    labels = _classify_daily(daily)
    last = labels.iloc[-1]
    if last.isna().any():
        logger.warning("latest regime row is incomplete: %s", last.to_dict())
        return None

    return RegimeUpdateInput(
        dt=_dt_str(daily["ts"].iloc[-1]),
        trend=last["trend"],
        vol=last["vol"],
        liquidity=last["liquidity"],
        model_version=REGIME_MODEL_VERSION,
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    base_url = os.environ["CRYPTOEDGE_API_URL"]
    token = os.environ["RESEARCH_API_TOKEN"]

    with InternalApiClient(base_url, token) as client:
        regime = compute_today_regime()
        if regime is None:
            logger.info("no regime update to submit")
            return 0
        written = client.submit_regimes([regime])
        logger.info("submitted %d regime row(s): %s", written, regime.model_dump())
    return 0


if __name__ == "__main__":
    sys.exit(main())
