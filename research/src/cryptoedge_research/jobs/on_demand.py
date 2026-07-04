"""On-demand EEP run (docs/01 §3.2 `research-on-demand`): triggered by a
`workflow_dispatch`/`repository_dispatch` when the UI asks the api Worker
to evaluate one Edge version. Counterpart to `jobs/nightly.py`, which runs
this same core loop across every ACTIVE/PAPER Edge each day.

`run_eep_for_edge_version` is the pure, fully-testable core (docs/11 §3:
no I/O, given data in and a result out). `main()` is the thin, largely
untestable-without-real-infra wiring that fetches that data from D1
(via the internal API) and R2, then posts results back.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import sys
import uuid
from typing import Any

import pandas as pd

from cryptoedge_research.dsl.evaluator import DslEvalInput, DslEvent, DslRegime, compute_fires
from cryptoedge_research.eval.backtest import (
    CostModel,
    forward_returns_series,
    parse_horizon_bars,
    run_backtest,
)
from cryptoedge_research.eval.pipeline import (
    PROTOCOL_VERSION,
    EepConfig,
    EepResult,
    eep_config_for_run_kind,
    run_eep,
)
from cryptoedge_research.io.internal_client import (
    InternalApiClient,
    RunMetricInput,
    StartRunRequest,
    SubmitVerdictRequest,
    VerdictReason,
)
from cryptoedge_research.io.lake import read_candles, read_dataset_hash, read_parquet
from cryptoedge_research.jobs.features_sync import FEATURE_SET_VERSION

logger = logging.getLogger(__name__)


def _referenced_features(expr: dict[str, Any]) -> set[str]:
    """Walks a BoolExpr (docs/05 §9) collecting every `feature` name it
    reads, mirroring the node shapes `evaluate_at` handles."""
    if "and" in expr:
        return {f for e in expr["and"] for f in _referenced_features(e)}
    if "or" in expr:
        return {f for e in expr["or"] for f in _referenced_features(e)}
    if "not" in expr:
        return _referenced_features(expr["not"])
    if "cmp" in expr:
        left, _op, right = expr["cmp"]
        features = {left["feature"]}
        if isinstance(right, dict):
            features.add(right["feature"])
        return features
    return set()  # event/regime/time nodes reference no feature series


def _referenced_event_types(expr: dict[str, Any]) -> set[str]:
    """Walks a BoolExpr (docs/05 §9) collecting every `event` node's `type`,
    mirroring `_referenced_features`. Used so a signal_spec that references
    an event type but was handed no real events (2026-07 review, TASK-1:
    previously silent — an event-referencing spec with an empty `events`
    table just never fired, producing a misleading 0-trade REJECT instead
    of a recorded failure) raises instead."""
    if "and" in expr:
        return {t for e in expr["and"] for t in _referenced_event_types(e)}
    if "or" in expr:
        return {t for e in expr["or"] for t in _referenced_event_types(e)}
    if "not" in expr:
        return _referenced_event_types(expr["not"])
    if "event" in expr:
        return {expr["event"]["type"]}
    return set()


def _uses_regime(expr: dict[str, Any]) -> bool:
    """Whether a BoolExpr contains any `regime` node — same rationale as
    `_referenced_event_types`, but for the `regime` node (docs/05 §9),
    which previously always evaluated against an all-None series since
    `main()` never fetched `regimes_daily` at all (2026-07 review, TASK-1)."""
    if "and" in expr:
        return any(_uses_regime(e) for e in expr["and"])
    if "or" in expr:
        return any(_uses_regime(e) for e in expr["or"])
    if "not" in expr:
        return _uses_regime(expr["not"])
    return "regime" in expr


def _ts_to_dt_str(ts_ms: int) -> str:
    return datetime.datetime.fromtimestamp(ts_ms / 1000, tz=datetime.UTC).strftime("%Y-%m-%d")


def _forward_fill_regimes(timestamps: list[int], regime_rows: list[dict[str, Any]]) -> list[DslRegime | None]:
    """Daily regime labels (docs/04 §6) forward-filled onto an hourly bar
    series: a bar takes its own dt's regime if labeled, else carries
    forward the most recent earlier dt's regime. `None` until the first
    labeled dt (e.g. bars older than regimes_daily's history)."""
    by_dt = {
        r["dt"]: DslRegime(trend=r["trend"], vol=r["vol"], liquidity=r["liquidity"]) for r in regime_rows
    }
    result: list[DslRegime | None] = []
    current: DslRegime | None = None
    for ts in timestamps:
        dt = _ts_to_dt_str(ts)
        if dt in by_dt:
            current = by_dt[dt]
        result.append(current)
    return result


def _bucket_events(
    events: list[dict[str, Any]], timestamps: list[int], bar_interval_ms: int
) -> list[list[DslEvent]]:
    """Assigns each raw event row (`ts`, `event_type`, `magnitude`) to the
    bar index whose `[timestamps[i], timestamps[i] + bar_interval_ms)`
    window contains it, matching how `evaluate_at`'s `event` node looks
    events up by bar index (docs/05 §9)."""
    n = len(timestamps)
    buckets: list[list[DslEvent]] = [[] for _ in range(n)]
    if n == 0:
        return buckets
    start = timestamps[0]
    for event in events:
        idx = (event["ts"] - start) // bar_interval_ms
        if 0 <= idx < n:
            magnitude = event.get("magnitude") or 0.0
            buckets[int(idx)].append(DslEvent(type=event["event_type"], magnitude=magnitude))
    return buckets


def run_eep_for_edge_version(
    edge_version: dict[str, Any],
    price_df: pd.DataFrame,
    bar_interval_ms: int,
    n_trials: int,
    config: EepConfig | None = None,
    regimes: list[DslRegime | None] | None = None,
    events: list[dict[str, Any]] | None = None,
) -> EepResult:
    """`price_df` needs `ts`, `open`, `close`, plus one column per feature the
    signal_spec's `when` clause references (docs/04 §3 feature store — in
    production these columns come from a join against the feature Parquet
    files, done by the caller before this function runs). Any column beyond
    ts/open/close is treated as a feature series keyed by its column name.
    A `when` clause referencing a feature outside that set can't be
    evaluated at all — rather than silently returning False (never-fires)
    at every bar, this raises so the job is recorded as failed instead of
    producing a misleading REJECT/zero-trades verdict (2026-07 review,
    Task 5).

    `regimes`/`events`, like features, must actually be supplied whenever
    the signal_spec references a `regime`/`event` node — an omitted-or-empty
    series there used to mean "that condition never fires", producing a
    misleading 0-trade REJECT instead of a recorded failure (2026-07
    review, TASK-1). `main()` supplies both via `InternalApiClient.get_regimes`/
    `get_events`."""
    signal_spec = json.loads(edge_version["signal_spec"])
    cost_model_raw = json.loads(edge_version["cost_model"])
    cost_model = CostModel(taker_bps=cost_model_raw["taker_bps"], slippage_bps=cost_model_raw["slippage_bps"])
    direction = edge_version["direction"]
    horizon = edge_version["horizon"]
    entry_delay_bars = signal_spec["entry"]["delay_bars"]

    timestamps = price_df["ts"].tolist()
    opens = price_df["open"].to_numpy(dtype=float)
    closes = price_df["close"].to_numpy(dtype=float)
    n = len(timestamps)
    regime_series: list[DslRegime | None] = regimes if regimes is not None else [None] * n

    feature_columns = [c for c in price_df.columns if c not in ("ts", "open", "close")]
    features = {col: price_df[col].tolist() for col in feature_columns}

    missing_features = _referenced_features(signal_spec["when"]) - set(features)
    if missing_features:
        raise ValueError(
            f"signal_spec references feature(s) not available in the fetched data: {sorted(missing_features)}"
        )

    referenced_event_types = _referenced_event_types(signal_spec["when"])
    if referenced_event_types and not events:
        missing_events = sorted(referenced_event_types)
        raise ValueError(
            f"signal_spec references event type(s) not available in the fetched data: {missing_events}"
        )

    if _uses_regime(signal_spec["when"]) and all(r is None for r in regime_series):
        raise ValueError("signal_spec references a regime condition but no regime data was supplied")

    dsl_input = DslEvalInput(
        timestamps=timestamps,
        features=features,
        events=_bucket_events(events or [], timestamps, bar_interval_ms),
        regimes=regime_series,
    )

    horizon_bars = parse_horizon_bars(horizon, bar_interval_ms)
    trades = run_backtest(
        signal_spec["when"],
        direction,
        horizon,
        cost_model,
        timestamps,
        opens,
        closes,
        bar_interval_ms,
        dsl_input,
        entry_delay_bars=entry_delay_bars,
    )
    fires = compute_fires(signal_spec["when"], dsl_input)
    # Tail bars have no future data to compute a return from yet and stay
    # NaN; permutation_test excludes them from both the observed EV and the
    # null draws rather than treating them as fake zero-returns (2026-07
    # review finding H-2).
    fwd = forward_returns_series(opens, closes, entry_delay_bars, horizon_bars, direction)

    return run_eep(trades, fwd, fires, horizon_bars, regime_series, n_trials, config or EepConfig())


def _submit_result(
    client: InternalApiClient,
    edge_version_id: str,
    dataset_hash: str,
    snapshot_id: str,
    result: EepResult,
    git_sha: str,
    run_kind: str = "full",
) -> str:
    run_id = client.start_run(
        StartRunRequest(
            edge_version_id=edge_version_id,
            protocol_version=PROTOCOL_VERSION,
            run_kind=run_kind,
            dataset_hash=dataset_hash,
            snapshot_id=snapshot_id,
            seed=0,
            config={},
            requested_by="system:research-worker",
            git_sha=git_sha,
        )
    )
    metric_inputs = [
        RunMetricInput(segment=m.segment, metric=m.metric, value=m.value, ci_lo=m.ci_lo, ci_hi=m.ci_hi)
        for m in result.metrics
    ]
    client.submit_metrics(run_id, metric_inputs)

    reason_inputs = [
        VerdictReason(check=r.check, passed=r.passed, value=r.value, threshold=r.threshold)
        for r in result.verdict.reasons
    ]
    client.submit_verdict(
        run_id,
        SubmitVerdictRequest(
            verdict=result.verdict.verdict,
            reasons=reason_inputs,
            thresholds_version="v1",
        ),
    )
    return run_id


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    base_url = os.environ["CRYPTOEDGE_API_URL"]
    token = os.environ["RESEARCH_API_TOKEN"]
    git_sha = os.environ.get("GITHUB_SHA", "unknown")

    with InternalApiClient(base_url, token) as client:
        jobs = client.claim_jobs(status="queued", limit=1)
        if not jobs:
            logger.info("no queued jobs")
            return 0
        job = jobs[0]
        payload = json.loads(job["payload"]) if isinstance(job["payload"], str) else job["payload"]
        edge_version_id = payload["edge_version_id"]
        # docs/08 POST /edges/{id}/eval's `kind` (screen/full) — this used to
        # be hardcoded to "full" regardless of what was requested, so a
        # screen-run request never satisfied the CANDIDATE->TESTING guard
        # (docs/05 §2), which specifically checks for a `run_kind='screen'`
        # row (2026-07: found while wiring up the eval-trigger endpoint).
        run_kind = payload.get("kind", "full")

        edge_version = client.get_edge_version(edge_version_id)
        # docs/05 §3.7: n_trials is the cumulative screen+full run count
        # against the edge, *including this run* — dispatch payloads only
        # pin an explicit n_trials for tests; production dispatch (docs/08
        # `/edges/{id}/eval`) doesn't know that count, so it's fetched here
        # (2026-07 review, Task 5).
        n_trials = payload.get("n_trials")
        if n_trials is None:
            n_trials = client.get_trial_count(edge_version["edge_id"]) + 1

        instrument_id = edge_version["instrument_id"]
        price_df = read_candles(instrument_id, "1h")
        # Feature Store v1 (docs/04 §3, 2026-07 review TASK-2): left-joined
        # onto the bar series by ts so signal_specs can reference these
        # feature names directly, same as any other price_df column. A
        # missing features file (jobs/features_sync.py hasn't run yet for
        # this instrument) just means no v1 features are available — the
        # existing missing-feature check in run_eep_for_edge_version
        # already fails the job cleanly if a signal_spec needed one.
        try:
            features_df = read_parquet(f"features/{FEATURE_SET_VERSION}/{instrument_id}/1h/data.parquet")
            price_df = price_df.merge(features_df, on="ts", how="left")
        except OSError:
            pass
        bar_interval_ms = 3_600_000
        events = (
            client.get_events(int(price_df["ts"].min()), int(price_df["ts"].max()) + bar_interval_ms)
            if len(price_df) > 0
            else []
        )
        # docs/04 §6 / docs/05 §3.8: regime-segmented metrics require the
        # DSL's `regime` node to actually see labeled data — previously
        # never fetched here at all (2026-07 review, TASK-1).
        regimes = (
            _forward_fill_regimes(
                price_df["ts"].tolist(),
                client.get_regimes(
                    _ts_to_dt_str(int(price_df["ts"].min())),
                    _ts_to_dt_str(int(price_df["ts"].max())),
                ),
            )
            if len(price_df) > 0
            else []
        )

        try:
            result = run_eep_for_edge_version(
                edge_version,
                price_df,
                bar_interval_ms,
                n_trials,
                config=eep_config_for_run_kind(run_kind),
                events=events,
                regimes=regimes,
            )
            snapshot_id = f"snapshot-{uuid.uuid4()}"
            # docs/01 §4.4: fingerprints exactly which R2 data version this
            # run evaluated against (jobs/lake_sync.write_snapshot_manifest
            # writes it weekly). "unknown" only if lake_sync hasn't run yet
            # (2026-07 review, Task 4).
            dataset_hash = read_dataset_hash()
            run_id = _submit_result(
                client, edge_version_id, dataset_hash, snapshot_id, result, git_sha, run_kind=run_kind
            )
            client.update_job_status(job["job_id"], "done", result_ref=run_id)
            logger.info("run %s completed: %s", run_id, result.verdict.verdict)
        except Exception as exc:  # noqa: BLE001 - top-level job failure must be recorded, not crash the Action
            logger.exception("job %s failed", job["job_id"])
            client.update_job_status(job["job_id"], "failed", error=str(exc))
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
