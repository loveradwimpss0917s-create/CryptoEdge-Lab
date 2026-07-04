"""HTTP client for the api Worker's `/internal/*` surface (docs/08
"Internal", docs/01 §5: research-worker never touches D1 directly).

The pydantic models here are the Python half of the cross-language
contract whose TypeScript half lives in
packages/schema/src/api/internal.ts — field names and shapes must match
exactly (docs/11 §4 "契約テスト").
"""

from __future__ import annotations

from typing import Any, Literal

import httpx
from pydantic import BaseModel

Verdict = Literal["ADOPT", "WATCH", "REJECT"]
RunKind = Literal["screen", "full", "incremental", "decay_check"]


class RunMetricInput(BaseModel):
    segment: str
    metric: str
    value: float
    ci_lo: float | None = None
    ci_hi: float | None = None
    meta: dict[str, Any] | None = None


class StartRunRequest(BaseModel):
    edge_version_id: str
    protocol_version: str
    run_kind: RunKind
    dataset_hash: str
    snapshot_id: str
    seed: int
    config: dict[str, Any]
    requested_by: str
    git_sha: str


class VerdictReason(BaseModel):
    check: str
    passed: bool
    value: float | None
    threshold: float | None


class SubmitVerdictRequest(BaseModel):
    verdict: Verdict
    score: float | None = None
    reasons: list[VerdictReason]
    thresholds_version: str


class DiscoveryFindingInput(BaseModel):
    finding_id: str
    batch_id: str
    kind: Literal[
        "conditional_return", "event_study", "interaction", "ml_importance", "anomaly", "changepoint"
    ]
    spec: dict[str, Any]
    stats: dict[str, Any]
    fdr_q: float
    novelty: float | None = None


class FeatureDefInput(BaseModel):
    feature_id: str
    version: int
    spec: dict[str, Any]
    cadence: str
    lookback_required: str | None = None
    family: str


class RegimeUpdateInput(BaseModel):
    dt: str
    trend: Literal["up", "down", "range"]
    vol: Literal["low", "high", "extreme"]
    liquidity: Literal["normal", "stressed"]
    hmm_state: int | None = None
    probs: list[float] | None = None
    model_version: str


class FundingRateInput(BaseModel):
    instrument_id: str
    ts: int
    rate: float
    predicted_rate: float | None = None
    mark_price: float | None = None


class OpenInterestInput(BaseModel):
    instrument_id: str
    ts: int
    oi_base: float
    oi_usd: float | None = None


class LongShortRatioInput(BaseModel):
    instrument_id: str
    ratio_type: str
    ts: int
    long_ratio: float
    short_ratio: float
    ls_ratio: float | None = None


class LiquidationInput(BaseModel):
    instrument_id: str
    ts: int
    long_liq_usd: float
    short_liq_usd: float
    events: int
    max_single_usd: float | None = None
    source_id: str


class CorrelationUpdateInput(BaseModel):
    edge_a: str
    edge_b: str
    window: Literal["1y", "all"]
    signal_overlap: float | None = None
    return_corr: float | None = None
    run_batch: str | None = None


class DqIssueOutput(BaseModel):
    stream_id: str
    rule_id: str
    severity: str
    detected_at: int
    detail: str | None = None


class VerdictSummaryOutput(BaseModel):
    verdict: Verdict
    run_kind: str
    edge_title: str
    decided_at: int


class ReadinessSummaryOutput(BaseModel):
    ready_count: int
    review_pending: dict[str, int]
    blocked_breakdown: dict[str, int]


class InternalApiError(Exception):
    def __init__(self, status_code: int, body: str):
        super().__init__(f"internal API returned HTTP {status_code}: {body[:500]}")
        self.status_code = status_code
        self.body = body


class InternalApiClient:
    """Thin wrapper; every call is a single JSON POST/GET with Bearer auth."""

    def __init__(self, base_url: str, token: str, timeout_s: float = 30.0):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout_s,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> InternalApiClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _post(self, path: str, payload: BaseModel | dict[str, Any]) -> dict[str, Any]:
        body = payload.model_dump(mode="json") if isinstance(payload, BaseModel) else payload
        res = self._client.post(path, json=body)
        if res.status_code >= 400:
            raise InternalApiError(res.status_code, res.text)
        return res.json()

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        res = self._client.get(path, params=params)
        if res.status_code >= 400:
            raise InternalApiError(res.status_code, res.text)
        return res.json()

    def claim_jobs(self, status: str = "queued", limit: int = 5) -> list[dict[str, Any]]:
        return self._get("/internal/jobs", params={"status": status, "limit": limit})["jobs"]

    def get_edge_version(self, version_id: str) -> dict[str, Any]:
        return self._get(f"/internal/edge-versions/{version_id}")["edge_version"]

    def get_trial_count(self, edge_id: str) -> int:
        """Cumulative screen+full eval_runs against this edge *before* the
        run about to be started (docs/05 §3.7 n_trials = this count + 1)."""
        return self._get(f"/internal/edges/{edge_id}/trial-count")["trial_count"]

    def get_events(self, from_ts: int, to_ts: int) -> list[dict[str, Any]]:
        """Events with `from_ts <= ts < to_ts`, for wiring the DSL's `event`
        node (docs/05 §9) with real data instead of an always-empty series."""
        return self._get("/internal/events", params={"from": from_ts, "to": to_ts})["events"]

    def get_regimes(self, from_dt: str, to_dt: str) -> list[dict[str, Any]]:
        """Daily regime labels with `from_dt <= dt <= to_dt` (both
        "YYYY-MM-DD"), for forward-filling onto the bar series the DSL's
        `regime` node (docs/05 §9) evaluates against — previously
        on_demand.py never fetched these at all (2026-07 review, TASK-1)."""
        return self._get("/internal/regimes", params={"from": from_dt, "to": to_dt})["regimes"]

    def get_dq_issues(self, since_ts: int) -> list[DqIssueOutput]:
        """Open DQ issues detected at/after `since_ts` (docs/07 §2 DATA
        section, docs/15 SONNET-2 daily_briefing pack)."""
        rows = self._get("/internal/dq-issues", params={"since": since_ts})["dq_issues"]
        return [DqIssueOutput.model_validate(r) for r in rows]

    def get_verdicts(self, since_ts: int) -> list[VerdictSummaryOutput]:
        """Verdicts decided at/after `since_ts`, joined to the edge title
        (docs/15 SONNET-2 daily_briefing pack)."""
        rows = self._get("/internal/verdicts", params={"since": since_ts})["verdicts"]
        return [VerdictSummaryOutput.model_validate(r) for r in rows]

    def get_readiness_summary(self) -> ReadinessSummaryOutput:
        """Same rollup as GET /api/v1/edges/readiness-summary (docs/06 §7.6),
        mirrored under Bearer auth so research-worker doesn't need Cloudflare
        Access credentials (docs/15 SONNET-2)."""
        return ReadinessSummaryOutput.model_validate(self._get("/internal/readiness-summary"))

    def submit_ai_output(
        self,
        kind: str,
        content_ref: str,
        model: str,
        prompt_version: str,
        ref_date: str | None = None,
        entity: str | None = None,
    ) -> str:
        """Registers a Research Pack already written to R2 at `content_ref`
        (docs/07 §2, docs/15 SONNET-2) so GET /api/v1/packs/:kind/latest can
        find and serve it."""
        result = self._post(
            "/internal/ai-outputs",
            {
                "kind": kind,
                "ref_date": ref_date,
                "entity": entity,
                "model": model,
                "prompt_version": prompt_version,
                "content_ref": content_ref,
            },
        )
        return result["output_id"]

    def get_backup_tables(self) -> list[str]:
        """The whitelisted table names the weekly backup job dumps (docs/12 §3)."""
        return self._get("/internal/backup/tables")["tables"]

    def get_backup_dump_page(self, table: str, after_rowid: int, limit: int = 2000) -> list[dict[str, Any]]:
        """One keyset-paginated page of `table`, ordered by rowid ascending."""
        return self._get(
            "/internal/backup/dump", params={"table": table, "after_rowid": after_rowid, "limit": limit}
        )["rows"]

    def update_job_status(
        self, job_id: str, status: str, error: str | None = None, result_ref: str | None = None
    ) -> None:
        payload = {"status": status}
        if error is not None:
            payload["error"] = error
        if result_ref is not None:
            payload["result_ref"] = result_ref
        self._post(f"/internal/jobs/{job_id}/status", payload)

    def start_run(self, req: StartRunRequest) -> str:
        return self._post("/internal/runs", req)["run_id"]

    def submit_metrics(self, run_id: str, metrics: list[RunMetricInput]) -> int:
        payload = {"metrics": [m.model_dump(mode="json") for m in metrics]}
        result = self._post(f"/internal/runs/{run_id}/metrics", payload)
        return result["written"]

    def submit_verdict(self, run_id: str, req: SubmitVerdictRequest) -> Verdict:
        return self._post(f"/internal/runs/{run_id}/verdict", req)["verdict"]

    def submit_findings(self, findings: list[DiscoveryFindingInput]) -> int:
        result = self._post("/internal/findings", {"findings": [f.model_dump(mode="json") for f in findings]})
        return result["written"]

    def submit_feature_defs(self, feature_defs: list[FeatureDefInput]) -> int:
        result = self._post(
            "/internal/feature-defs", {"feature_defs": [f.model_dump(mode="json") for f in feature_defs]}
        )
        return result["written"]

    def submit_regimes(self, regimes: list[RegimeUpdateInput]) -> int:
        result = self._post("/internal/regimes", {"regimes": [r.model_dump(mode="json") for r in regimes]})
        return result["written"]

    def submit_funding_rates(self, funding_rates: list[FundingRateInput]) -> int:
        result = self._post(
            "/internal/funding-rates", {"funding_rates": [f.model_dump(mode="json") for f in funding_rates]}
        )
        return result["written"]

    def submit_deriv_metrics(
        self, open_interest: list[OpenInterestInput], long_short_ratios: list[LongShortRatioInput]
    ) -> int:
        result = self._post(
            "/internal/deriv-metrics",
            {
                "open_interest": [o.model_dump(mode="json") for o in open_interest],
                "long_short_ratios": [r.model_dump(mode="json") for r in long_short_ratios],
            },
        )
        return result["written"]

    def submit_liquidations(self, liquidations: list[LiquidationInput]) -> int:
        result = self._post(
            "/internal/liquidations", {"liquidations": [liq.model_dump(mode="json") for liq in liquidations]}
        )
        return result["written"]

    def submit_correlations(self, correlations: list[CorrelationUpdateInput]) -> int:
        result = self._post(
            "/internal/correlations", {"correlations": [c.model_dump(mode="json") for c in correlations]}
        )
        return result["written"]
