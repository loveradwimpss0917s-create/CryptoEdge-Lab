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


class RegimeUpdateInput(BaseModel):
    dt: str
    trend: Literal["up", "down", "range"]
    vol: Literal["low", "high", "extreme"]
    liquidity: Literal["normal", "stressed"]
    hmm_state: int | None = None
    probs: list[float] | None = None
    model_version: str


class CorrelationUpdateInput(BaseModel):
    edge_a: str
    edge_b: str
    window: Literal["1y", "all"]
    signal_overlap: float | None = None
    return_corr: float | None = None
    run_batch: str | None = None


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

    def submit_regimes(self, regimes: list[RegimeUpdateInput]) -> int:
        result = self._post("/internal/regimes", {"regimes": [r.model_dump(mode="json") for r in regimes]})
        return result["written"]

    def submit_correlations(self, correlations: list[CorrelationUpdateInput]) -> int:
        result = self._post(
            "/internal/correlations", {"correlations": [c.model_dump(mode="json") for c in correlations]}
        )
        return result["written"]
