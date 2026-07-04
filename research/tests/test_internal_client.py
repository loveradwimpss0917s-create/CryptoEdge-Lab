"""Exercises InternalApiClient against a mock transport — no real network,
just verifying request shape/auth header match the docs/08 contract."""

import json

import httpx
import pytest

from cryptoedge_research.io.internal_client import (
    InternalApiClient,
    InternalApiError,
    RunMetricInput,
    StartRunRequest,
    SubmitVerdictRequest,
    VerdictReason,
)


def _client_with_handler(handler) -> InternalApiClient:
    client = InternalApiClient.__new__(InternalApiClient)
    client._client = httpx.Client(  # noqa: SLF001 - test constructs the internal transport directly
        base_url="https://api.example.test",
        headers={"Authorization": "Bearer test-token"},
        transport=httpx.MockTransport(handler),
    )
    return client


def test_start_run_sends_bearer_auth_and_correct_body():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(201, json={"run_id": "run-123"})

    client = _client_with_handler(handler)
    run_id = client.start_run(
        StartRunRequest(
            edge_version_id="v1",
            protocol_version="1.0",
            run_kind="full",
            dataset_hash="abc",
            snapshot_id="snap-1",
            seed=42,
            config={"n_folds": 5},
            requested_by="system:research-worker",
            git_sha="deadbeef",
        )
    )
    assert run_id == "run-123"
    assert captured["auth"] == "Bearer test-token"
    assert captured["body"]["edge_version_id"] == "v1"
    assert captured["body"]["config"] == {"n_folds": 5}


def test_submit_metrics_serializes_list_correctly():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(201, json={"run_id": "run-1", "written": 2})

    client = _client_with_handler(handler)
    written = client.submit_metrics(
        "run-1",
        [
            RunMetricInput(segment="overall", metric="ev_bps", value=12.3),
            RunMetricInput(segment="wf:oos", metric="sharpe", value=1.2, ci_lo=0.8, ci_hi=1.6),
        ],
    )
    assert written == 2
    assert len(captured["body"]["metrics"]) == 2
    assert captured["body"]["metrics"][1]["ci_lo"] == 0.8


def test_submit_verdict_round_trips_reasons():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["verdict"] == "ADOPT"
        assert body["reasons"][0]["check"] == "adopt.sharpe"
        return httpx.Response(201, json={"run_id": "run-1", "verdict": "ADOPT"})

    client = _client_with_handler(handler)
    verdict = client.submit_verdict(
        "run-1",
        SubmitVerdictRequest(
            verdict="ADOPT",
            score=88.0,
            reasons=[VerdictReason(check="adopt.sharpe", passed=True, value=1.5, threshold=1.0)],
            thresholds_version="v1",
        ),
    )
    assert verdict == "ADOPT"


def test_error_response_raises_internal_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="invalid internal token")

    client = _client_with_handler(handler)
    with pytest.raises(InternalApiError):
        client.claim_jobs()


def test_get_dq_issues_parses_rows(monkeypatch: pytest.MonkeyPatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["since"] == "100"
        return httpx.Response(
            200,
            json={
                "dq_issues": [
                    {"stream_id": "s1", "rule_id": "DQ-01", "severity": "critical", "detected_at": 100}
                ]
            },
        )

    client = _client_with_handler(handler)
    issues = client.get_dq_issues(100)
    assert len(issues) == 1
    assert issues[0].rule_id == "DQ-01"


def test_get_verdicts_parses_rows():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "verdicts": [
                    {"verdict": "ADOPT", "run_kind": "full", "edge_title": "cme-gap-fill", "decided_at": 500}
                ]
            },
        )

    client = _client_with_handler(handler)
    verdicts = client.get_verdicts(0)
    assert verdicts[0].verdict == "ADOPT"
    assert verdicts[0].edge_title == "cme-gap-fill"


def test_get_readiness_summary_parses_rollup():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ready_count": 3,
                "review_pending": {"screen": 1, "full": 0},
                "blocked_breakdown": {
                    "build_pending": 5, "signal_spec_pending": 7, "feature_pending": 2, "data_pending": 4
                },
            },
        )

    client = _client_with_handler(handler)
    readiness = client.get_readiness_summary()
    assert readiness.ready_count == 3
    assert readiness.blocked_breakdown["build_pending"] == 5


def test_submit_ai_output_sends_pack_pointer():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(201, json={"output_id": "o1"})

    client = _client_with_handler(handler)
    output_id = client.submit_ai_output(
        kind="briefing",
        content_ref="packs/briefing/2026-07-04.md",
        model="template",
        prompt_version="daily_briefing-1.0",
        ref_date="2026-07-04"
    )
    assert output_id == "o1"
    assert captured["body"]["kind"] == "briefing"
    assert captured["body"]["content_ref"] == "packs/briefing/2026-07-04.md"
