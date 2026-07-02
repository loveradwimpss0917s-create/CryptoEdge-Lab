import numpy as np
import pytest

from cryptoedge_research.dsl.evaluator import DslEvalInput
from cryptoedge_research.eval.backtest import (
    CostModel,
    forward_returns_series,
    parse_horizon_bars,
    run_backtest,
)


def test_parse_horizon_bars_various_units():
    assert parse_horizon_bars("30m", bar_interval_ms=5 * 60_000) == 6  # 30m / 5m bars
    assert parse_horizon_bars("72h", bar_interval_ms=3_600_000) == 72
    assert parse_horizon_bars("1d", bar_interval_ms=86_400_000) == 1


def test_parse_horizon_bars_rejects_unknown_format():
    with pytest.raises(ValueError):
        parse_horizon_bars("nonsense", bar_interval_ms=60_000)


def _flat_dsl_input(n: int, fire_at: set[int]) -> DslEvalInput:
    return DslEvalInput(
        timestamps=[i * 3_600_000 for i in range(n)],
        features={"flag": [1.0 if i in fire_at else 0.0 for i in range(n)]},
        events=[[] for _ in range(n)],
        regimes=[None] * n,
    )


def test_long_trade_next_bar_open_entry_and_cost_applied():
    n = 5
    opens = np.array([100.0, 100.0, 110.0, 110.0, 121.0])
    closes = np.array([100.0, 100.0, 110.0, 110.0, 121.0])
    dsl_input = _flat_dsl_input(n, fire_at={0})
    when = {"cmp": [{"feature": "flag"}, ">", 0.5]}
    cost = CostModel(taker_bps=4, slippage_bps=2)  # round trip = 12 bps

    trades = run_backtest(
        when=when,
        direction="long",
        horizon="1h",
        cost_model=cost,
        timestamps=dsl_input.timestamps,
        opens=opens,
        closes=closes,
        bar_interval_ms=3_600_000,
        dsl_input=dsl_input,
        entry_delay_bars=1,
    )
    assert len(trades) == 1
    trade = trades[0]
    assert trade.entry_index == 1  # signal at 0, entry at next bar
    assert trade.exit_index == 2  # 1h horizon = 1 bar later
    gross = (110.0 / 100.0 - 1.0) * 10_000
    assert trade.ret_bps == pytest.approx(gross)
    assert trade.ret_net_bps == pytest.approx(gross - 12)


def test_short_trade_inverts_return_direction():
    n = 3
    opens = np.array([100.0, 100.0, 90.0])
    closes = np.array([100.0, 100.0, 90.0])
    dsl_input = _flat_dsl_input(n, fire_at={0})
    when = {"cmp": [{"feature": "flag"}, ">", 0.5]}
    cost = CostModel(taker_bps=0, slippage_bps=0)

    trades = run_backtest(
        when, "short", "1h", cost, dsl_input.timestamps, opens, closes, 3_600_000, dsl_input
    )
    assert len(trades) == 1
    # Price fell 100 -> 90: a short profits.
    assert trades[0].ret_bps > 0
    assert trades[0].ret_bps == pytest.approx((100.0 / 90.0 - 1.0) * 10_000)


def test_trade_dropped_when_exit_would_run_past_available_data():
    n = 3
    opens = np.array([100.0, 100.0, 100.0])
    closes = np.array([100.0, 100.0, 100.0])
    dsl_input = _flat_dsl_input(n, fire_at={2})  # fires on the last bar -> no room to exit
    when = {"cmp": [{"feature": "flag"}, ">", 0.5]}
    cost = CostModel(taker_bps=0, slippage_bps=0)

    trades = run_backtest(
        when, "long", "1h", cost, dsl_input.timestamps, opens, closes, 3_600_000, dsl_input
    )
    assert trades == []


def test_signal_sign_direction_not_yet_supported():
    dsl_input = _flat_dsl_input(3, fire_at=set())
    with pytest.raises(NotImplementedError):
        run_backtest(
            {"cmp": [{"feature": "flag"}, ">", 0.5]},
            "signal_sign",
            "1h",
            CostModel(0, 0),
            dsl_input.timestamps,
            np.zeros(3),
            np.zeros(3),
            3_600_000,
            dsl_input,
        )


def test_forward_returns_series_matches_manual_calculation():
    opens = np.array([100.0, 100.0, 105.0, 105.0])
    closes = np.array([100.0, 100.0, 105.0, 110.0])
    series = forward_returns_series(opens, closes, entry_delay_bars=1, horizon_bars=1, direction="long")
    # i=0: entry_idx=1 (open=100), exit_idx=2 (close=105)
    assert series[0] == pytest.approx((105.0 / 100.0 - 1.0) * 10_000)
    # i=1: entry_idx=2 (open=105), exit_idx=3 (close=110)
    assert series[1] == pytest.approx((110.0 / 105.0 - 1.0) * 10_000)
    assert np.isnan(series[2])  # entry_idx=3, exit_idx=4 >= n -> not enough data
    assert np.isnan(series[3])
