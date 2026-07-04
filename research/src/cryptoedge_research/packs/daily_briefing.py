"""Research Pack: daily_briefing (docs/07 §2-4, docs/15 SONNET-2 V1 slice).

Deterministic template — no AI call (docs/07 §3 "AI なしで成立させる"). The
platform's job here is only to assemble what's real today into the standard
Pack structure (ROLE & TASK / CONTEXT / DATA / QUESTIONS / GUARDRAILS) so a
researcher can paste it into Claude/ChatGPT/Gemini for the analysis itself.

V1 slice: the DATA section covers what this pass actually wires up (regime,
open DQ issues, recent verdicts, Research Readiness rollup). docs/07 §3's
full TL;DR priority order also includes decay alerts and 発火損益, which
depend on paper_signals volume (still unimplemented, docs/14 §6) and CUSUM
decay checks (docs/09 §4, not yet built) — left out rather than fabricated.
"""

from __future__ import annotations

from cryptoedge_research.io.internal_client import (
    DqIssueOutput,
    ReadinessSummaryOutput,
    RegimeUpdateInput,
    VerdictSummaryOutput,
)

PACK_VERSION = "daily_briefing-1.0"

_ROLE_AND_TASK = (
    "あなたはクオンツ研究の批評者である。以下のプラットフォーム状況を検証し、"
    "見落としている異変や矛盾があれば指摘せよ。"
)

_CONTEXT = (
    "CryptoEdge Lab: 暗号資産の統計的エッジを収集・検証する個人研究基盤。\n"
    "- EEP (Edge Evaluation Protocol): screen (安価な足切り) → full (ウォークフォワード"
    "+ permutation + DSR による本評価) の2段階評価。\n"
    "- Research Readiness: 各EdgeがSignalSpec作成前か、featureやdataが揃うのを待っているか、"
    "評価可能か、評価済みかを示す状態軸。"
)

_QUESTIONS = [
    "今日注視すべき異変は何か?",
    "DQ issueは実データ不良か、それとも本物の市場イベントか?",
    "REJECTされたEdgeのうち、パラメータ再探索の価値があるものはあるか?",
    "今すぐ評価可能なEdgeのうち、今日着手すべき優先順位は?"
]

_GUARDRAILS = [
    "新しい数値を創作しない。DATAセクションにない値を断定しない。",
    "verdict (ADOPT/WATCH/REJECT) の判定はこのPackの外で機械的に決定済み — 再判定を提案する場合は"
    "その根拠を明示すること。",
    "データが無い/不足している項目は「不明」と答え、推測で埋めない。"
]


def _format_regime(regime: RegimeUpdateInput | None) -> str:
    if regime is None:
        return "本日のレジーム: 不明 (履歴不足のため未算出)"
    return (
        f"本日のレジーム: trend={regime.trend}, vol={regime.vol}, "
        f"liquidity={regime.liquidity} (dt={regime.dt})"
    )


def _format_dq_issues(dq_issues: list[DqIssueOutput]) -> str:
    if not dq_issues:
        return "オープン中のDQ issue: なし"
    lines = [f"オープン中のDQ issue ({len(dq_issues)}件):"]
    for issue in dq_issues[:10]:
        lines.append(
            f"- [{issue.severity}] {issue.rule_id} "
            f"(stream={issue.stream_id}, detected_at={issue.detected_at})"
        )
    return "\n".join(lines)


def _format_verdicts(verdicts: list[VerdictSummaryOutput]) -> str:
    if not verdicts:
        return "直近の新規verdict: なし"
    lines = [f"直近の新規verdict ({len(verdicts)}件):"]
    for v in verdicts[:10]:
        lines.append(f"- {v.edge_title}: {v.verdict} ({v.run_kind}, decided_at={v.decided_at})")
    return "\n".join(lines)


def _format_readiness(readiness: ReadinessSummaryOutput) -> str:
    blocked = readiness.blocked_breakdown
    return (
        f"今すぐ評価可能: {readiness.ready_count}件 / "
        f"レビュー待ち: screen {readiness.review_pending.get('screen', 0)}件, "
        f"full {readiness.review_pending.get('full', 0)}件\n"
        f"ブロック内訳: 実装待ち {blocked.get('build_pending', 0)}件, "
        f"SignalSpec待ち {blocked.get('signal_spec_pending', 0)}件, "
        f"Feature待ち {blocked.get('feature_pending', 0)}件, "
        f"Data待ち {blocked.get('data_pending', 0)}件"
    )


def build_daily_briefing(
    ref_date: str,
    regime: RegimeUpdateInput | None,
    dq_issues: list[DqIssueOutput],
    verdicts: list[VerdictSummaryOutput],
    readiness: ReadinessSummaryOutput,
) -> str:
    """Assembles the daily_briefing Pack markdown. Pure function (no I/O) so
    it's unit-testable against fixture inputs (docs/11 §2)."""
    sections = [
        f"# Daily Briefing — {ref_date}",
        "",
        "## 1. ROLE & TASK",
        _ROLE_AND_TASK,
        "",
        "## 2. CONTEXT",
        _CONTEXT,
        "",
        "## 3. DATA",
        _format_regime(regime),
        "",
        _format_dq_issues(dq_issues),
        "",
        _format_verdicts(verdicts),
        "",
        _format_readiness(readiness),
        "",
        "## 4. QUESTIONS",
        *(f"- {q}" for q in _QUESTIONS),
        "",
        "## 5. GUARDRAILS",
        *(f"- {g}" for g in _GUARDRAILS)
    ]
    return "\n".join(sections) + "\n"
