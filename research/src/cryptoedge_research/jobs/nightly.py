"""Daily-light job (docs/01 §3.2 `research-daily`, docs/09 Phase 2).

V1/Phase 2 scope: recompute today's rule-based regime label (docs/04 §6),
submit it, and generate the daily_briefing Research Pack (docs/07 §2-4,
docs/15 SONNET-2). The remaining daily-light responsibility from docs/09
§4 (CUSUM decay checks against ACTIVE/PAPER Edges) depends on
paper_signals volume, which is still unimplemented (docs/14 §6) — left as
follow-up work rather than stubbed out here with fabricated behavior.
"""

from __future__ import annotations

import datetime
import logging
import os
import sys

import pandas as pd

from cryptoedge_research.io.internal_client import InternalApiClient, RegimeUpdateInput
from cryptoedge_research.io.lake import read_candles, write_bytes
from cryptoedge_research.packs.daily_briefing import PACK_VERSION, build_daily_briefing
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


def generate_daily_briefing(client: InternalApiClient, regime: RegimeUpdateInput | None) -> str:
    """Builds and registers today's daily_briefing Research Pack (docs/07
    §2-4, docs/15 SONNET-2). Runs even when `regime` is None (not enough
    history yet) — the briefing should still surface DQ/verdict/readiness
    state on a day the regime classifier can't produce a label, rather than
    silently skipping the whole Pack."""
    ref_date = datetime.datetime.now(tz=datetime.UTC).strftime("%Y-%m-%d")
    since = int(datetime.datetime.now(tz=datetime.UTC).timestamp() * 1000) - 24 * 60 * 60 * 1000

    dq_issues = client.get_dq_issues(since)
    verdicts = client.get_verdicts(since)
    readiness = client.get_readiness_summary()

    content = build_daily_briefing(ref_date, regime, dq_issues, verdicts, readiness)
    content_ref = f"packs/briefing/{ref_date}.md"
    write_bytes(content_ref, content.encode("utf-8"))

    output_id = client.submit_ai_output(
        kind="briefing",
        content_ref=content_ref,
        model="template",
        prompt_version=PACK_VERSION,
        ref_date=ref_date,
    )
    logger.info("generated daily_briefing pack %s -> %s", output_id, content_ref)
    return output_id


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    base_url = os.environ["CRYPTOEDGE_API_URL"]
    token = os.environ["RESEARCH_API_TOKEN"]

    with InternalApiClient(base_url, token) as client:
        regime = compute_today_regime()
        if regime is None:
            logger.info("no regime update to submit")
        else:
            written = client.submit_regimes([regime])
            logger.info("submitted %d regime row(s): %s", written, regime.model_dump())

        generate_daily_briefing(client, regime)
    return 0


if __name__ == "__main__":
    sys.exit(main())
