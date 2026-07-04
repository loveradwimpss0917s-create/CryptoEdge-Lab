import numpy as np
import pandas as pd
import pytest

from cryptoedge_research.io.internal_client import ReadinessSummaryOutput
from cryptoedge_research.jobs.nightly import (
    compute_regime_history,
    compute_today_regime,
    generate_daily_briefing,
)


def test_returns_none_with_insufficient_history(monkeypatch: pytest.MonkeyPatch):
    def fake_read_candles(instrument_id: str, tf: str) -> pd.DataFrame:
        return pd.DataFrame({"ts": [0, 86_400_000], "close": [100.0, 101.0]})

    monkeypatch.setattr("cryptoedge_research.jobs.nightly.read_candles", fake_read_candles)
    assert compute_today_regime() is None


def test_returns_a_regime_update_with_enough_history(monkeypatch: pytest.MonkeyPatch):
    n = 260
    rng = np.random.default_rng(0)
    closes = 100 + np.cumsum(rng.normal(0.5, 1.0, n))  # gentle uptrend

    def fake_read_candles(instrument_id: str, tf: str) -> pd.DataFrame:
        return pd.DataFrame({"ts": [i * 86_400_000 for i in range(n)], "close": closes})

    monkeypatch.setattr("cryptoedge_research.jobs.nightly.read_candles", fake_read_candles)
    result = compute_today_regime()
    assert result is not None
    assert result.model_version == "rule-based-1.0"
    assert result.trend in {"up", "down", "range"}


def test_history_backfill_returns_empty_with_insufficient_history(monkeypatch: pytest.MonkeyPatch):
    def fake_read_candles(instrument_id: str, tf: str) -> pd.DataFrame:
        return pd.DataFrame({"ts": [0, 86_400_000], "close": [100.0, 101.0]})

    monkeypatch.setattr("cryptoedge_research.jobs.nightly.read_candles", fake_read_candles)
    assert compute_regime_history() == []


def test_history_backfill_covers_every_classifiable_day_not_just_the_latest(monkeypatch: pytest.MonkeyPatch):
    n = 260
    rng = np.random.default_rng(0)
    closes = 100 + np.cumsum(rng.normal(0.5, 1.0, n))

    def fake_read_candles(instrument_id: str, tf: str) -> pd.DataFrame:
        return pd.DataFrame({"ts": [i * 86_400_000 for i in range(n)], "close": closes})

    monkeypatch.setattr("cryptoedge_research.jobs.nightly.read_candles", fake_read_candles)
    history = compute_regime_history()
    # Only the earliest rows (not enough trailing history for ADX/realized
    # vol yet) are skipped; the backfill should cover most of the sample,
    # not just today's single row the way compute_today_regime does.
    assert len(history) > 1
    assert all(h.model_version == "rule-based-1.0" for h in history)
    # dt strings should be strictly increasing (one row per classifiable day).
    assert [h.dt for h in history] == sorted(h.dt for h in history)


class _FakeClient:
    """Stand-in for InternalApiClient — generate_daily_briefing only calls
    these three read methods plus submit_ai_output (docs/15 SONNET-2)."""

    def __init__(self):
        self.submitted: dict | None = None

    def get_dq_issues(self, since_ts: int) -> list:
        return []

    def get_verdicts(self, since_ts: int) -> list:
        return []

    def get_readiness_summary(self) -> ReadinessSummaryOutput:
        return ReadinessSummaryOutput(
            ready_count=1,
            review_pending={"screen": 0, "full": 0},
            blocked_breakdown={
                "build_pending": 0, "signal_spec_pending": 0, "feature_pending": 0, "data_pending": 0
            },
        )

    def submit_ai_output(self, **kwargs) -> str:
        self.submitted = kwargs
        return "output-1"


def test_generate_daily_briefing_writes_to_r2_and_registers_it(monkeypatch: pytest.MonkeyPatch):
    written = {}

    def fake_write_bytes(key: str, data: bytes) -> None:
        written["key"] = key
        written["data"] = data

    monkeypatch.setattr("cryptoedge_research.jobs.nightly.write_bytes", fake_write_bytes)
    client = _FakeClient()

    output_id = generate_daily_briefing(client, None)

    assert output_id == "output-1"
    assert written["key"].startswith("packs/briefing/")
    assert b"ROLE & TASK" in written["data"]
    assert client.submitted is not None
    assert client.submitted["kind"] == "briefing"
    assert client.submitted["content_ref"] == written["key"]


def test_generate_daily_briefing_runs_even_without_a_regime_label(monkeypatch: pytest.MonkeyPatch):
    """A day the regime classifier can't produce a label (insufficient
    history) shouldn't silently skip the whole Pack — DQ/verdict/readiness
    state is still real and worth surfacing."""
    monkeypatch.setattr("cryptoedge_research.jobs.nightly.write_bytes", lambda key, data: None)
    client = _FakeClient()
    output_id = generate_daily_briefing(client, None)
    assert output_id == "output-1"
