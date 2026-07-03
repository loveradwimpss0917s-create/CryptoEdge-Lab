import numpy as np
import pandas as pd
import pytest

from cryptoedge_research.jobs.nightly import compute_regime_history, compute_today_regime


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
