"""Anchored walk-forward splitting with purging + embargo (docs/05 §3.4).

Train windows always expand from the start of the sample and are
*purged* of any trades whose evaluation window (`entry_ts`..`exit_ts`)
could overlap the following test window, plus a fixed `embargo_ms`
safety margin (docs/05 §3.4: "自己相関のある forward return では通常 CV が
壊滅的に楽観化する" — López de Prado's purging/embargo argument). Because
train is always strictly chronologically before its purge boundary, no
embargo is needed *after* test here (that concern applies to k-fold CV
with non-sequential splits, which this project does not use — see
docs/05 §3.4 for why anchored WF was chosen over full CPCV for V1).

Splits are computed over wall-clock time (`entry_ts`/`exit_ts`), not
array position: trades cluster unevenly in time (a signal firing more
often in volatile stretches), so an index-based split silently gives
folds wildly uneven calendar spans and lets a trade's outcome window
leak across the split boundary whenever bar-count purging doesn't
match the trade's actual holding period (2026-07 review finding H-3).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

_DEFAULT_EMBARGO_MS = 5 * 86_400_000  # 5 days, per the 2026-07 review's default


class _TimedTrade(Protocol):
    entry_ts: int
    exit_ts: int


@dataclass(frozen=True)
class WalkForwardFold:
    fold_index: int
    train_idx: list[int]
    test_idx: list[int]


def anchored_walk_forward_splits(
    trades: list[_TimedTrade],
    n_folds: int = 5,
    embargo_ms: int = _DEFAULT_EMBARGO_MS,
) -> list[WalkForwardFold]:
    """Splits `trades` into `n_folds` anchored (expanding-window) folds by
    calendar time.

    The sample's time span (earliest `entry_ts` to latest `exit_ts`) is
    divided into `n_folds + 1` equal-width blocks; block 0 is reserved as
    the minimum initial training history, and each subsequent block
    becomes one fold's test window. A trade belongs to train only if its
    *entire* evaluation window closes at least `embargo_ms` before the
    test window starts; trades whose exit lands inside the embargo gap
    are dropped from both train and test, matching the purge/embargo
    behavior for anchored (not k-fold) walk-forward.

    Indices in `train_idx`/`test_idx` refer to positions in the input
    `trades` list, so callers can use them directly against a same-order
    returns array.
    """
    if n_folds < 1:
        raise ValueError("n_folds must be >= 1")
    n = len(trades)
    if n < n_folds + 1:
        raise ValueError(f"not enough samples ({n}) for {n_folds} folds")

    order = sorted(range(n), key=lambda i: trades[i].entry_ts)
    start_ts = trades[order[0]].entry_ts
    end_ts = max(t.exit_ts for t in trades)
    span = end_ts - start_ts
    if span <= 0:
        raise ValueError(f"not enough samples ({n}) for {n_folds} folds")
    block = span / (n_folds + 1)

    folds: list[WalkForwardFold] = []
    for i in range(1, n_folds + 1):
        test_start_ts = start_ts + i * block
        test_end_ts = end_ts + 1 if i == n_folds else start_ts + (i + 1) * block
        purge_boundary_ts = test_start_ts - embargo_ms
        train_idx = sorted(idx for idx in order if trades[idx].exit_ts <= purge_boundary_ts)
        test_idx = sorted(idx for idx in order if test_start_ts <= trades[idx].entry_ts < test_end_ts)
        folds.append(WalkForwardFold(fold_index=i, train_idx=train_idx, test_idx=test_idx))
    return folds
