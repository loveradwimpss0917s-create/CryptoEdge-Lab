"""docs/05 §5 rule table, transcribed as tests so the thresholds can't
silently drift from the design doc."""

from cryptoedge_research.eval.verdict import VerdictInputs, VerdictThresholds, decide_verdict

GOOD = VerdictInputs(
    ev_bps_ci_lo=5.0,
    ev_bps_ci_hi=20.0,
    sharpe=1.5,
    dsr=0.95,
    p_perm=0.01,
    n_eff=100,
    fold_consistency=0.8,
    regime_worst_ev_bps=-2.0,
    ev_bps=10.0,
    top5_concentration=0.3,
    corr_max_active=0.2,
    recent_2y_ev_bps=8.0,
)


def test_all_conditions_met_adopts():
    outcome = decide_verdict(GOOD)
    assert outcome.verdict == "ADOPT"
    assert all(r.passed for r in outcome.reasons)


def test_ci_upper_below_zero_forces_reject_even_if_everything_else_passes():
    bad = GOOD.__class__(**{**GOOD.__dict__, "ev_bps_ci_hi": -1.0})
    assert decide_verdict(bad).verdict == "REJECT"


def test_high_p_perm_forces_reject():
    bad = GOOD.__class__(**{**GOOD.__dict__, "p_perm": 0.5})
    assert decide_verdict(bad).verdict == "REJECT"


def test_low_dsr_forces_reject():
    bad = GOOD.__class__(**{**GOOD.__dict__, "dsr": 0.3})
    assert decide_verdict(bad).verdict == "REJECT"


def test_negative_recent_2y_ev_forces_reject():
    bad = GOOD.__class__(**{**GOOD.__dict__, "recent_2y_ev_bps": -5.0})
    assert decide_verdict(bad).verdict == "REJECT"


def test_sharpe_just_below_threshold_is_watch_not_adopt():
    watch = GOOD.__class__(**{**GOOD.__dict__, "sharpe": 0.9})
    outcome = decide_verdict(watch)
    assert outcome.verdict == "WATCH"


def test_n_eff_too_low_is_watch_not_reject():
    watch = GOOD.__class__(**{**GOOD.__dict__, "n_eff": 10})
    outcome = decide_verdict(watch)
    assert outcome.verdict == "WATCH"


def test_top5_concentration_too_high_is_watch():
    watch = GOOD.__class__(**{**GOOD.__dict__, "top5_concentration": 0.8})
    assert decide_verdict(watch).verdict == "WATCH"


def test_correlated_with_active_portfolio_blocks_adopt():
    watch = GOOD.__class__(**{**GOOD.__dict__, "corr_max_active": 0.9})
    assert decide_verdict(watch).verdict == "WATCH"


def test_custom_thresholds_are_respected():
    strict = VerdictThresholds(min_sharpe=2.0)
    outcome = decide_verdict(GOOD, strict)
    assert outcome.verdict == "WATCH"  # 1.5 no longer clears a 2.0 bar
