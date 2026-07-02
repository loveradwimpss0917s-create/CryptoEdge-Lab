"""Daily-light job (docs/01 §3.2 `research-daily`, docs/09 Phase 2).

V1/Phase 2 scope: recompute today's rule-based regime label (docs/04 §6)
and submit it. The remaining daily-light responsibilities from docs/09
(§4 CUSUM decay checks against ACTIVE/PAPER Edges, Research Pack
generation) depend on paper_signals volume and the AI-handoff Pack
templates (docs/07) respectively, and are intentionally left as follow-up
work rather than stubbed out here with fabricated behavior.
"""

from __future__ import annotations

import logging
import os
import sys

from cryptoedge_research.io.internal_client import InternalApiClient, RegimeUpdateInput
from cryptoedge_research.io.lake import read_candles
from cryptoedge_research.regimes.rule_based import classify_regime

logger = logging.getLogger(__name__)

REGIME_MODEL_VERSION = "rule-based-1.0"


def compute_today_regime(instrument_id: str = "BTCUSDT.BINANCE.PERP") -> RegimeUpdateInput | None:
    daily = read_candles(instrument_id, "1d")
    if len(daily) < 200:
        logger.warning("not enough daily history (%d rows) to classify a regime yet", len(daily))
        return None

    zeros = daily["close"] * 0.0  # placeholder liquidity inputs until those series are ingested (docs/03)
    labels = classify_regime(
        close=daily["close"],
        high=daily.get("high", daily["close"]),
        low=daily.get("low", daily["close"]),
        spread_bps=zeros,
        liq_zscore=zeros,
        peg_dev_bps=zeros,
    )
    last = labels.iloc[-1]
    if last.isna().any():
        logger.warning("latest regime row is incomplete: %s", last.to_dict())
        return None

    dt = daily["ts"].iloc[-1]
    import datetime

    dt_str = datetime.datetime.fromtimestamp(dt / 1000, tz=datetime.UTC).strftime("%Y-%m-%d")
    return RegimeUpdateInput(
        dt=dt_str,
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
