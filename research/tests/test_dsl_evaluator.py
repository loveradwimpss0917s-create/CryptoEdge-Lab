"""Cross-language DSL contract test (docs/11 §4).

Reads the exact same fixture file the TypeScript evaluator
(workers/ingest/src/signals/dsl-evaluator.test.ts) reads. If this test
and its TS twin both pass, the two runtimes agree on DSL semantics.
"""

import json
from pathlib import Path

import pytest

from cryptoedge_research.dsl.evaluator import DslEvalInput, DslEvent, DslRegime, compute_fires

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "packages" / "schema" / "fixtures" / "dsl-golden.json"
)


def _load_vectors() -> list[dict]:
    with FIXTURE_PATH.open() as f:
        return json.load(f)["vectors"]


VECTORS = _load_vectors()


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_golden_vector(vector: dict) -> None:
    events = [[DslEvent(**e) for e in bucket] for bucket in vector["events"]]
    regimes = [DslRegime(**r) if r is not None else None for r in vector["regimes"]]
    inp = DslEvalInput(
        timestamps=vector["timestamps"],
        features=vector["features"],
        events=events,
        regimes=regimes,
    )
    assert compute_fires(vector["when"], inp) == vector["expected_fires"]
