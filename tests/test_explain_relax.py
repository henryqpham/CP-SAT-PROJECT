"""explain_infeasible + relax_by_priority on small, cheap scenarios."""
from models import Scenario
from solver import explain_infeasible, relax_by_priority, solve


def scenario(activities, constraints):
    return Scenario.model_validate({"activities": activities, "constraints": constraints})


def test_explain_returns_minimal_conflict(lake_infeasible):
    result = explain_infeasible(lake_infeasible)
    assert result["structural"] is False
    assert result["conflict_ids"]
    # minimal: disabling any single member frees the plan
    for cid in result["conflict_ids"]:
        trial = lake_infeasible.model_copy(deep=True)
        next(c for c in trial.constraints if c.id == cid).enabled = False
        assert solve(trial)["status"] == "OPTIMAL"


def test_explain_feasible_plan_is_empty(lake):
    assert explain_infeasible(lake) == {"structural": False, "conflict_ids": []}


def test_explain_structural_when_activity_cannot_fit():
    # 2000 minutes never fits the default 1440-minute day; no rules involved
    too_big = scenario([{"id": "big", "duration": 2000}], [])
    assert solve(too_big)["status"] == "INFEASIBLE"
    assert explain_infeasible(too_big) == {"structural": True, "conflict_ids": []}


def test_relax_drops_the_lowest_priority_rule():
    # start >= 12:00 (P1) vs end <= 12:30 (P3) on a 60-minute task
    mixed = scenario(
        [{"id": "task", "duration": 60}],
        [
            {"type": "time_window", "id": "hard", "activity": "task",
             "earliest": "12:00", "priority": 1},
            {"type": "time_window", "id": "soft", "activity": "task",
             "latest_end": "12:30", "priority": 3},
        ],
    )
    result = relax_by_priority(mixed)
    assert result["solved"] is True
    assert result["dropped"] == ["soft"]
    assert result["structural"] is False
    assert result["hard_conflict"] == []


def test_relax_never_drops_a_hard_rule():
    all_hard = scenario(
        [{"id": "task", "duration": 60}],
        [
            {"type": "time_window", "id": "h1", "activity": "task",
             "earliest": "12:00", "priority": 1},
            {"type": "time_window", "id": "h2", "activity": "task",
             "latest_end": "12:30", "priority": 1},
        ],
    )
    result = relax_by_priority(all_hard)
    assert result["solved"] is False
    assert result["dropped"] == []
    assert set(result["hard_conflict"]) == {"h1", "h2"}


def test_relax_on_feasible_plan_is_a_noop(lake):
    result = relax_by_priority(lake)
    assert result["solved"] is True
    assert result["dropped"] == []
