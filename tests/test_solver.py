"""Solver behavior tests (solver.py): one small hand-built scenario per behavior."""
from models import Scenario
from solver import solve

DAY = 1440


def run_plan(activities, constraints, horizon=None):
    scenario = Scenario.model_validate(
        {"activities": activities, "constraints": constraints, "horizon": horizon}
    )
    return solve(scenario)


def by_id(result):
    assert result["status"] == "OPTIMAL"
    return {e["id"]: e for e in result["schedule"]}


def disjoint(x, y):
    return x["end"] <= y["start"] or y["end"] <= x["start"]


# --- result shape ---

def test_solve_result_shape():
    r = run_plan([{"id": "a", "duration": 60}], [])
    assert r["status"] == "OPTIMAL"
    assert r["horizon"] == DAY  # default = one day
    assert isinstance(r["schedule"], list)
    entry = r["schedule"][0]
    assert entry["id"] == "a"
    assert entry["source"] == "a"
    assert entry["end"] - entry["start"] == 60


def test_infeasible_returns_status_only():
    # 60-min activity in a 29-min window
    r = run_plan(
        [{"id": "a", "duration": 60}],
        [{"type": "time_window", "activity": "a", "earliest": "23:30", "latest_end": "23:59"}],
    )
    assert r["status"] == "INFEASIBLE"
    assert "schedule" not in r


# --- time_window ---

def test_time_window_pins_activity():
    r = run_plan(
        [{"id": "a", "duration": 60}],
        [{"type": "time_window", "activity": "a", "earliest": "10:00", "latest_end": "11:00"}],
    )
    a = by_id(r)["a"]
    assert a["start"] == 600
    assert a["end"] == 660


def test_time_window_day_offsets_to_that_day():
    r = run_plan(
        [{"id": "a", "duration": 60}],
        [{"type": "time_window", "activity": "a",
          "earliest": "10:00", "latest_end": "11:00", "day": 1}],
        horizon=2 * DAY,
    )
    a = by_id(r)["a"]
    assert a["start"] == DAY + 600
    assert a["end"] == DAY + 660


# --- precedence / sequence ---

def test_precedence_orders_two_activities():
    r = run_plan(
        [{"id": "a", "duration": 60}, {"id": "b", "duration": 60}],
        [{"type": "precedence", "before": "a", "after": "b"}],
    )
    s = by_id(r)
    assert s["a"]["end"] <= s["b"]["start"]


def test_sequence_chains_three_activities():
    r = run_plan(
        [{"id": "a", "duration": 30}, {"id": "b", "duration": 30}, {"id": "c", "duration": 30}],
        [{"type": "sequence", "activities": ["a", "b", "c"]}],
    )
    s = by_id(r)
    assert s["a"]["end"] <= s["b"]["start"]
    assert s["b"]["end"] <= s["c"]["start"]


# --- no_overlap + sections ---

def test_no_overlap_all():
    r = run_plan(
        [{"id": "a", "duration": 60}, {"id": "b", "duration": 60}],
        [{"type": "no_overlap"}],
    )
    s = by_id(r)
    assert disjoint(s["a"], s["b"])


def test_no_overlap_named_list_leaves_others_free():
    acts = [{"id": i, "duration": 60} for i in ("a", "b", "c")]
    # 120-min window fits a+b disjoint but not all three
    windows = [{"type": "time_window", "activity": i,
                "earliest": "10:00", "latest_end": "12:00"} for i in ("a", "b", "c")]
    r = run_plan(acts, windows + [{"type": "no_overlap", "activities": ["a", "b"]}])
    s = by_id(r)
    assert disjoint(s["a"], s["b"])
    # c is not covered, so it must share time with a or b (pigeonhole)
    assert not disjoint(s["c"], s["a"]) or not disjoint(s["c"], s["b"])
    # same plan with "all" cannot fit
    r_all = run_plan(acts, windows + [{"type": "no_overlap", "activities": "all"}])
    assert r_all["status"] == "INFEASIBLE"


def test_same_section_never_overlaps():
    r = run_plan(
        [{"id": "a", "duration": 60, "section": "kitchen"},
         {"id": "b", "duration": 60, "section": "kitchen"}],
        [],
    )
    s = by_id(r)
    assert disjoint(s["a"], s["b"])


# --- conditional ---

def test_conditional_dropped_trigger_doubles_target():
    # trigger can't fit its 29-min window, so the solver must drop it
    r = run_plan(
        [{"id": "trigger", "duration": 60}, {"id": "task", "duration": 30}],
        [{"type": "conditional",
          "when": {"activity": "trigger", "present": False},
          "then": {"set_duration": {"activity": "task", "factor": 2}}},
         {"type": "time_window", "activity": "trigger",
          "earliest": "23:30", "latest_end": "23:59"}],
    )
    s = by_id(r)
    assert "trigger" not in s
    assert s["task"]["end"] - s["task"]["start"] == 60


def test_conditional_kept_trigger_keeps_base_duration():
    # objective keeps optional activities, so trigger stays and task stays 30
    r = run_plan(
        [{"id": "trigger", "duration": 60}, {"id": "task", "duration": 30}],
        [{"type": "conditional",
          "when": {"activity": "trigger", "present": False},
          "then": {"set_duration": {"activity": "task", "factor": 2}}}],
    )
    s = by_id(r)
    assert "trigger" in s
    assert s["task"]["end"] - s["task"]["start"] == 30


# --- working_window ---

def test_working_window_confines_same_day():
    r = run_plan(
        [{"id": "a", "duration": 60}],
        [{"type": "working_window", "open": "09:00", "close": "17:00"}],
    )
    a = by_id(r)["a"]
    assert a["start"] >= 540
    assert a["end"] <= 1020


def test_working_window_repeats_each_day():
    # activity forced onto day 1 still has to obey that day's window
    r = run_plan(
        [{"id": "a", "duration": 60}],
        [{"type": "working_window", "open": "09:00", "close": "17:00"},
         {"type": "time_window", "activity": "a", "earliest": "00:00", "day": 1}],
        horizon=2 * DAY,
    )
    a = by_id(r)["a"]
    assert a["start"] >= DAY + 540
    assert a["end"] <= DAY + 1020


def test_working_window_overnight_wrap():
    # open 22:00 close 06:00 -> closed block is 06:00..22:00
    r = run_plan(
        [{"id": "a", "duration": 60}],
        [{"type": "working_window", "open": "22:00", "close": "06:00"}],
    )
    a = by_id(r)["a"]
    assert a["end"] <= 360 or a["start"] >= 1320


def test_working_window_days_filter_leaves_other_days_open():
    act = [{"id": "a", "duration": DAY}]  # a full-day activity
    ww = {"type": "working_window", "open": "09:00", "close": "17:00", "days": [0]}
    r = run_plan(act, [ww], horizon=2 * DAY)
    a = by_id(r)["a"]
    assert a["start"] >= DAY  # day 0 is windowed, day 1 is fully open
    # with the window on every day nothing can hold a full-day activity
    ww_all = dict(ww, days="all")
    assert run_plan(act, [ww_all], horizon=2 * DAY)["status"] == "INFEASIBLE"


# --- section_budget ---

def test_section_budget_cap_below_total_infeasible():
    acts = [{"id": "a", "duration": 60, "section": "ops"},
            {"id": "b", "duration": 60, "section": "ops"}]
    r = run_plan(acts, [{"type": "section_budget", "section": "ops", "max_minutes": 100}])
    assert r["status"] == "INFEASIBLE"


def test_section_budget_cap_above_total_solves():
    acts = [{"id": "a", "duration": 60, "section": "ops"},
            {"id": "b", "duration": 60, "section": "ops"}]
    r = run_plan(acts, [{"type": "section_budget", "section": "ops", "max_minutes": 150}])
    assert r["status"] == "OPTIMAL"


# --- overlap ---

def test_overlap_contains_outer_covers_inner():
    r = run_plan(
        [{"id": "outer", "duration": 120}, {"id": "inner", "duration": 30}],
        [{"type": "overlap", "outer": "outer", "inner": "inner", "mode": "contains"},
         {"type": "time_window", "activity": "inner",
          "earliest": "10:00", "latest_end": "10:30"}],
    )
    s = by_id(r)
    assert s["outer"]["start"] <= s["inner"]["start"]
    assert s["inner"]["end"] <= s["outer"]["end"]


def test_overlap_overlaps_mode_shares_time():
    r = run_plan(
        [{"id": "a", "duration": 60}, {"id": "b", "duration": 60}],
        [{"type": "overlap", "outer": "a", "inner": "b", "mode": "overlaps"},
         {"type": "time_window", "activity": "a",
          "earliest": "10:00", "latest_end": "11:00"}],
    )
    s = by_id(r)
    assert s["b"]["start"] < s["a"]["end"]
    assert s["a"]["start"] < s["b"]["end"]


# --- time_lag ---

def test_time_lag_adjacency_end_equals_start():
    r = run_plan(
        [{"id": "a", "duration": 60}, {"id": "b", "duration": 60}],
        [{"type": "time_lag", "from_id": "a", "to_id": "b", "min_lag": 0, "max_lag": 0}],
    )
    s = by_id(r)
    assert s["b"]["start"] == s["a"]["end"]


def test_time_lag_bare_max_bounds_gap():
    r = run_plan(
        [{"id": "a", "duration": 60}, {"id": "b", "duration": 60}],
        [{"type": "time_lag", "from_id": "a", "to_id": "b", "max_lag": 30}],
    )
    s = by_id(r)
    assert 0 <= s["b"]["start"] - s["a"]["end"] <= 30


def test_time_lag_bare_max_implies_order():
    # b is windowed BEFORE a; a bare max_lag still forces b after a -> infeasible
    r = run_plan(
        [{"id": "a", "duration": 60}, {"id": "b", "duration": 60}],
        [{"type": "time_lag", "from_id": "a", "to_id": "b", "max_lag": 600},
         {"type": "time_window", "activity": "a", "earliest": "12:00"},
         {"type": "time_window", "activity": "b", "latest_end": "10:00"}],
    )
    assert r["status"] == "INFEASIBLE"


def test_time_lag_span_cap():
    acts = [{"id": "a", "duration": 100}, {"id": "b", "duration": 100}]
    prec = {"type": "precedence", "before": "a", "after": "b"}
    span = {"type": "time_lag", "from_id": "a", "to_id": "b",
            "from_anchor": "start", "to_anchor": "end", "max_lag": 150}
    # a..b needs at least 200 minutes, cap of 150 can't hold it
    assert run_plan(acts, [prec, span])["status"] == "INFEASIBLE"
    r = run_plan(acts, [prec, dict(span, max_lag=250)])
    s = by_id(r)
    assert s["b"]["end"] - s["a"]["start"] <= 250


# --- min_separation ---

def test_min_separation_gap_holds_in_either_order():
    acts = [{"id": "a", "duration": 60}, {"id": "b", "duration": 60}]
    sep = {"type": "min_separation", "a": "a", "b": "b", "gap": 30}
    # force a first
    r = run_plan(acts, [sep, {"type": "time_window", "activity": "a", "latest_end": "01:00"}])
    s = by_id(r)
    assert s["b"]["start"] >= s["a"]["end"] + 30
    # force b first
    r = run_plan(acts, [sep, {"type": "time_window", "activity": "b", "latest_end": "01:00"}])
    s = by_id(r)
    assert s["a"]["start"] >= s["b"]["end"] + 30


# --- recurs_daily ---

def test_recurs_daily_expands_one_occurrence_per_day():
    r = run_plan(
        [{"id": "lunch", "duration": 30, "recurs_daily": True,
          "daily_window": {"open": "12:00", "close": "13:00"}}],
        [],
        horizon=2 * DAY,
    )
    s = by_id(r)
    assert sorted(s) == ["lunch#d1", "lunch#d2"]
    for entry in s.values():
        assert entry["source"] == "lunch"
    # each occurrence sits inside its own day's window
    assert 720 <= s["lunch#d1"]["start"] and s["lunch#d1"]["end"] <= 780
    assert DAY + 720 <= s["lunch#d2"]["start"] and s["lunch#d2"]["end"] <= DAY + 780


def test_recurs_daily_days_filter_limits_days():
    r = run_plan(
        [{"id": "lunch", "duration": 30, "recurs_daily": True, "days": [1],
          "daily_window": {"open": "12:00", "close": "13:00"}}],
        [],
        horizon=2 * DAY,
    )
    s = by_id(r)
    assert sorted(s) == ["lunch#d2"]
    assert DAY + 720 <= s["lunch#d2"]["start"] and s["lunch#d2"]["end"] <= DAY + 780


# --- occ_pairs pairing ---

def test_time_lag_between_recurring_binds_every_day():
    r = run_plan(
        [{"id": "wake", "duration": 10, "recurs_daily": True,
          "daily_window": {"open": "06:00", "close": "08:00"}},
         {"id": "brief", "duration": 10, "recurs_daily": True}],
        [{"type": "time_lag", "from_id": "wake", "to_id": "brief",
          "min_lag": 0, "max_lag": 30}],
        horizon=2 * DAY,
    )
    s = by_id(r)
    for d in ("d1", "d2"):
        lag = s[f"brief#{d}"]["start"] - s[f"wake#{d}"]["end"]
        assert 0 <= lag <= 30


def test_time_lag_day_shift_pairs_across_midnight():
    r = run_plan(
        [{"id": "a", "duration": 10, "recurs_daily": True},
         {"id": "b", "duration": 10, "recurs_daily": True}],
        [{"type": "time_lag", "from_id": "a", "to_id": "b",
          "day_shift": 1, "max_lag": 120}],
        horizon=2 * DAY,
    )
    s = by_id(r)
    # a's day-1 occurrence pairs with b's day-2 occurrence
    lag = s["b#d2"]["start"] - s["a#d1"]["end"]
    assert 0 <= lag <= 120
    # b#d2 can't start before day 2, so a#d1 is pulled to the end of day 1
    assert s["a#d1"]["end"] >= DAY - 120


def test_bare_recurring_id_in_precedence_not_dropped():
    r = run_plan(
        [{"id": "lunch", "duration": 30, "recurs_daily": True},
         {"id": "review", "duration": 60}],
        [{"type": "precedence", "before": "lunch", "after": "review"}],
        horizon=2 * DAY,
    )
    s = by_id(r)
    # review starts after EVERY lunch occurrence, including day 2's
    assert s["review"]["start"] >= s["lunch#d1"]["end"]
    assert s["review"]["start"] >= s["lunch#d2"]["end"]
    assert s["review"]["start"] >= DAY + 30
