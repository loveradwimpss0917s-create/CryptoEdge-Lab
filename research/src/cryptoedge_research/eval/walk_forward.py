"""Anchored walk-forward splitting with purging + embargo (docs/05 §3.4).

Train windows always expand from the start of the sample and are
*purged* of any bars whose forward-looking label window (`horizon_bars`)
could overlap the following test window, plus a fixed `embargo_bars`
safety margin (docs/05 §3.4: "自己相関のある forward return では通常 CV が
壊滅的に楽観化する" — López de Prado's purging/embargo argument). Because
train is always strictly chronologically before its purge boundary, no
embargo is needed *after* test here (that concern applies to k-fold CV
with non-sequential splits, which this project does not use — see
docs/05 §3.4 for why anchored WF was chosen over full CPCV for V1).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WalkForwardFold:
    fold_index: int
    train_idx: list[int]
    test_idx: list[int]


def anchored_walk_forward_splits(
    n: int,
    n_folds: int = 5,
    horizon_bars: int = 1,
    embargo_bars: int = 0,
) -> list[WalkForwardFold]:
    """Splits `range(n)` into `n_folds` anchored (expanding-window) folds.

    The sample is divided into `n_folds + 1` equal-ish contiguous blocks;
    block 0 is reserved as the minimum initial training history, and each
    subsequent block becomes one fold's test set with all *purged* prior
    data as its training set.
    """
    if n_folds < 1:
        raise ValueError("n_folds must be >= 1")
    fold_size = n // (n_folds + 1)
    if fold_size < 1:
        raise ValueError(f"not enough samples ({n}) for {n_folds} folds")

    folds: list[WalkForwardFold] = []
    for i in range(1, n_folds + 1):
        test_start = i * fold_size
        test_end = n if i == n_folds else (i + 1) * fold_size
        purge_start = max(0, test_start - horizon_bars - embargo_bars)
        folds.append(
            WalkForwardFold(
                fold_index=i,
                train_idx=list(range(0, purge_start)),
                test_idx=list(range(test_start, test_end)),
            )
        )
    return folds
