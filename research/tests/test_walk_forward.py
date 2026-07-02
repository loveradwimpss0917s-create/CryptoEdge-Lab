import pytest

from cryptoedge_research.eval.walk_forward import anchored_walk_forward_splits


def test_folds_cover_the_tail_of_the_sample_without_overlap():
    folds = anchored_walk_forward_splits(120, n_folds=5, horizon_bars=1)
    assert len(folds) == 5
    all_test_idx = [i for f in folds for i in f.test_idx]
    # Test sets partition the back 5/6 of the sample with no gaps or overlaps.
    assert all_test_idx == list(range(20, 120))


def test_train_never_includes_indices_at_or_after_test_start():
    folds = anchored_walk_forward_splits(100, n_folds=4, horizon_bars=3, embargo_bars=2)
    for fold in folds:
        test_start = fold.test_idx[0]
        assert max(fold.train_idx, default=-1) < test_start


def test_purging_removes_horizon_plus_embargo_window_before_test():
    folds = anchored_walk_forward_splits(100, n_folds=4, horizon_bars=5, embargo_bars=3)
    fold1 = folds[0]
    test_start = fold1.test_idx[0]
    expected_purge_start = max(0, test_start - 5 - 3)
    assert fold1.train_idx == list(range(expected_purge_start))


def test_train_expands_across_folds():
    folds = anchored_walk_forward_splits(100, n_folds=4, horizon_bars=0)
    train_sizes = [len(f.train_idx) for f in folds]
    assert train_sizes == sorted(train_sizes)  # anchored/expanding, never shrinks


def test_raises_when_too_few_samples_for_requested_folds():
    with pytest.raises(ValueError):
        anchored_walk_forward_splits(3, n_folds=5)
