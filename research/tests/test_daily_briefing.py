from cryptoedge_research.io.internal_client import (
    DqIssueOutput,
    ReadinessSummaryOutput,
    RegimeUpdateInput,
    VerdictSummaryOutput,
)
from cryptoedge_research.packs.daily_briefing import build_daily_briefing


def _readiness(**overrides) -> ReadinessSummaryOutput:
    base = {
        "ready_count": 0,
        "review_pending": {"screen": 0, "full": 0},
        "blocked_breakdown": {
            "build_pending": 0, "signal_spec_pending": 0, "feature_pending": 0, "data_pending": 0
        },
    }
    base.update(overrides)
    return ReadinessSummaryOutput.model_validate(base)


def test_includes_all_standard_pack_sections():
    content = build_daily_briefing("2026-07-04", None, [], [], _readiness())
    for heading in ["ROLE & TASK", "CONTEXT", "DATA", "QUESTIONS", "GUARDRAILS"]:
        assert heading in content


def test_reports_unknown_regime_without_fabricating_a_label():
    content = build_daily_briefing("2026-07-04", None, [], [], _readiness())
    assert "不明" in content


def test_includes_regime_label_when_available():
    regime = RegimeUpdateInput(
        dt="2026-07-04", trend="up", vol="low", liquidity="normal", model_version="rule-based-1.0"
    )
    content = build_daily_briefing("2026-07-04", regime, [], [], _readiness())
    assert "trend=up" in content
    assert "vol=low" in content


def test_lists_open_dq_issues():
    issues = [
        DqIssueOutput(
            stream_id="okx_rest:candles_1m:BTC", rule_id="DQ-01", severity="critical", detected_at=100
        )
    ]
    content = build_daily_briefing("2026-07-04", None, issues, [], _readiness())
    assert "DQ-01" in content
    assert "critical" in content


def test_reports_no_dq_issues_explicitly_rather_than_omitting_the_section():
    content = build_daily_briefing("2026-07-04", None, [], [], _readiness())
    assert "オープン中のDQ issue: なし" in content


def test_lists_recent_verdicts():
    verdicts = [
        VerdictSummaryOutput(
            verdict="REJECT", run_kind="screen", edge_title="funding-rate-mean-reversion", decided_at=100
        )
    ]
    content = build_daily_briefing("2026-07-04", None, [], verdicts, _readiness())
    assert "funding-rate-mean-reversion" in content
    assert "REJECT" in content


def test_includes_readiness_rollup():
    readiness = _readiness(
        ready_count=3,
        blocked_breakdown={
            "build_pending": 5, "signal_spec_pending": 7, "feature_pending": 2, "data_pending": 4
        }
    )
    content = build_daily_briefing("2026-07-04", None, [], [], readiness)
    assert "今すぐ評価可能: 3件" in content
    assert "実装待ち 5件" in content
