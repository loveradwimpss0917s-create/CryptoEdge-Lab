"""Verdict rules (docs/05 §5) — the one place that decides ADOPT / WATCH /
REJECT. Deliberately simple, deterministic threshold logic: the *hard*
statistical work already happened in metrics.py/dsr.py/permutation.py/
bootstrap.py, and this module only compares their outputs against
`settings['thresholds.eep']` (docs/02 `settings`). Never let an LLM or
any heuristic touch this function (docs/00 §3 principle 9).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Verdict = Literal["ADOPT", "WATCH", "REJECT"]


@dataclass(frozen=True)
class VerdictThresholds:
    """Defaults transcribed from docs/05 §5. Overridable per `settings['thresholds.eep']`."""

    min_sharpe: float = 1.0
    min_dsr_adopt: float = 0.90
    max_dsr_reject: float = 0.50
    max_p_perm_adopt: float = 0.05
    min_p_perm_reject: float = 0.30
    min_n_eff: float = 30.0
    min_fold_consistency: float = 0.7
    max_top5_concentration: float = 0.6
    max_corr_with_active: float = 0.7


@dataclass(frozen=True)
class VerdictInputs:
    ev_bps_ci_lo: float
    ev_bps_ci_hi: float
    sharpe: float
    dsr: float
    p_perm: float
    n_eff: float
    fold_consistency: float
    regime_worst_ev_bps: float
    ev_bps: float
    top5_concentration: float
    corr_max_active: float | None
    recent_2y_ev_bps: float | None


@dataclass(frozen=True)
class VerdictReason:
    check: str
    passed: bool
    value: float | None
    threshold: float | None


@dataclass(frozen=True)
class VerdictOutcome:
    verdict: Verdict
    reasons: list[VerdictReason] = field(default_factory=list)


def decide_verdict(
    inputs: VerdictInputs, thresholds: VerdictThresholds | None = None
) -> VerdictOutcome:
    thresholds = thresholds or VerdictThresholds()
    reasons: list[VerdictReason] = []

    def check(name: str, passed: bool, value: float | None, threshold: float | None) -> bool:
        reasons.append(VerdictReason(name, passed, value, threshold))
        return passed

    def check_avoids(name: str, is_disqualifying: bool, value: float | None, threshold: float | None) -> bool:
        """Like `check`, but for REJECT-style conditions: `passed=True` in the
        recorded reason means the disqualifying condition was *avoided*
        (consistent "True = good" semantics across all reasons, docs/06
        Dossier shows these as a uniform pass/fail checklist)."""
        reasons.append(VerdictReason(name, not is_disqualifying, value, threshold))
        return is_disqualifying

    # --- REJECT: any of these being true is disqualifying, checked first ---
    reject_ci_upper = check_avoids(
        "reject.ci_upper_below_zero", inputs.ev_bps_ci_hi < 0, inputs.ev_bps_ci_hi, 0.0
    )
    reject_p_perm = check_avoids(
        "reject.p_perm_too_high",
        inputs.p_perm > thresholds.min_p_perm_reject,
        inputs.p_perm,
        thresholds.min_p_perm_reject,
    )
    reject_dsr = check_avoids(
        "reject.dsr_too_low", inputs.dsr < thresholds.max_dsr_reject, inputs.dsr, thresholds.max_dsr_reject
    )
    reject_recent = False
    if inputs.recent_2y_ev_bps is not None:
        reject_recent = check_avoids(
            "reject.recent_2y_ev_negative", inputs.recent_2y_ev_bps < 0, inputs.recent_2y_ev_bps, 0.0
        )

    if reject_ci_upper or reject_p_perm or reject_dsr or reject_recent:
        return VerdictOutcome("REJECT", reasons)

    # --- ADOPT: all of these must hold ---
    adopt_checks = [
        check("adopt.ci_lower_above_zero", inputs.ev_bps_ci_lo > 0, inputs.ev_bps_ci_lo, 0.0),
        check("adopt.sharpe", inputs.sharpe >= thresholds.min_sharpe, inputs.sharpe, thresholds.min_sharpe),
        check("adopt.dsr", inputs.dsr >= thresholds.min_dsr_adopt, inputs.dsr, thresholds.min_dsr_adopt),
        check(
            "adopt.p_perm",
            inputs.p_perm < thresholds.max_p_perm_adopt,
            inputs.p_perm,
            thresholds.max_p_perm_adopt,
        ),
        check("adopt.n_eff", inputs.n_eff >= thresholds.min_n_eff, inputs.n_eff, thresholds.min_n_eff),
        check(
            "adopt.fold_consistency",
            inputs.fold_consistency >= thresholds.min_fold_consistency,
            inputs.fold_consistency,
            thresholds.min_fold_consistency,
        ),
        check(
            "adopt.regime_worst_ev",
            inputs.regime_worst_ev_bps > -2 * inputs.ev_bps,
            inputs.regime_worst_ev_bps,
            -2 * inputs.ev_bps,
        ),
        check(
            "adopt.top5_concentration",
            inputs.top5_concentration < thresholds.max_top5_concentration,
            inputs.top5_concentration,
            thresholds.max_top5_concentration,
        ),
    ]
    if inputs.corr_max_active is not None:
        adopt_checks.append(
            check(
                "adopt.corr_max_active",
                inputs.corr_max_active < thresholds.max_corr_with_active,
                inputs.corr_max_active,
                thresholds.max_corr_with_active,
            )
        )

    if all(adopt_checks):
        return VerdictOutcome("ADOPT", reasons)

    return VerdictOutcome("WATCH", reasons)


def score(inputs: VerdictInputs) -> float:
    """0-100 sort key for the UI (docs/05 §6) — not used for the verdict decision itself."""
    dsr_term = 40 * min(inputs.dsr, 1.0)
    sharpe_term = 20 * min(inputs.sharpe / 2, 1.0)
    fold_term = 15 * inputs.fold_consistency
    conc_term = 15 * (1 - inputs.top5_concentration)
    regime_breadth_term = 10.0  # placeholder pending multi-regime segment wiring (Phase 2 follow-up)
    return dsr_term + sharpe_term + fold_term + conc_term + regime_breadth_term
