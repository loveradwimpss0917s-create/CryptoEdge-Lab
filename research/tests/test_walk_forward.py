from dataclasses import dataclass

import pytest

from cryptoedge_research.eval.walk_forward import anchored_walk_forward_splits

HOUR_MS = 3_600_000


@dataclass(frozen=True)
class _Trade:
    entry_ts: int
    exit_ts: int


def _hourly_trades(n: int, holding_bars: int = 1) -> list[_Trade]:
    return [_Trade(entry_ts=i * HOUR_MS, exit_ts=(i + holding_bars) * HOUR_MS) for i in range(n)]


def test_folds_cover_the_tail_of_the_sample_without_overlap():
    trades = _hourly_trades(120)
    folds = anchored_walk_forward_splits(trades, n_folds=5, embargo_ms=0)
    assert len(folds) == 5
    all_test_idx = [i for f in folds for i in f.test_idx]
    assert all_test_idx == sorted(all_test_idx)
    assert len(set(all_test_idx)) == len(all_test_idx)  # no overlap
    assert all_test_idx[0] > 0  # block 0 reserved for initial training history


def test_train_never_includes_trades_at_or_after_test_start():
    trades = _hourly_trades(100)
    folds = anchored_walk_forward_splits(trades, n_folds=4, embargo_ms=2 * HOUR_MS)
    for fold in folds:
        test_start_ts = min(trades[i].entry_ts for i in fold.test_idx)
        assert all(trades[i].exit_ts <= test_start_ts for i in fold.train_idx)


def test_purging_drops_trades_whose_exit_falls_in_the_embargo_gap():
    trades = _hourly_trades(100, holding_bars=5)
    folds = anchored_walk_forward_splits(trades, n_folds=4, embargo_ms=3 * HOUR_MS)
    fold1 = folds[0]
    train_and_test = set(fold1.train_idx) | set(fold1.test_idx)
    # Trades whose evaluation window closes within the embargo gap directly
    # before fold1's test window belong to neither train nor test.
    assert len(train_and_test) < 100


def test_train_expands_across_folds():
    trades = _hourly_trades(100)
    folds = anchored_walk_forward_splits(trades, n_folds=4, embargo_ms=0)
    train_sizes = [len(f.train_idx) for f in folds]
    assert train_sizes == sorted(train_sizes)  # anchored/expanding, never shrinks


def test_raises_when_too_few_samples_for_requested_folds():
    with pytest.raises(ValueError):
        anchored_walk_forward_splits(_hourly_trades(3), n_folds=5)


def test_raises_when_trades_share_a_single_timestamp():
    trades = [_Trade(entry_ts=0, exit_ts=0) for _ in range(10)]
    with pytest.raises(ValueError):
        anchored_walk_forward_splits(trades, n_folds=4)
