"""The fill/utilization solve path (solve_fill + /fill): pack the horizon,
report %-filled per section, list what didn't fit. solve() itself is untouched —
the rest of the suite pins that."""
import json

import pytest

from conftest import EXAMPLES
from models import Scenario
from solver import solve_fill


def test_zero_or_negative_duration_is_rejected_by_the_ir():
    # duration >= 1: a 0/negative duration would wedge the solver silently, and the
    # assistant's tools rely on the IR to bounce bad model-chosen values.
    with pytest.raises(Exception):
        Scenario.model_validate({"activities": [{"id": "a", "duration": 0}], "constraints": []})
    with pytest.raises(Exception):
        Scenario.model_validate({"activities": [{"id": "a", "duration": -60}], "constraints": []})


def scenario(activities, constraints=(), horizon=None):
    return Scenario.model_validate(
        {"activities": activities, "constraints": list(constraints), "horizon": horizon})


def test_packs_the_best_subset_in_a_serial_section():
    # a+b = 110 > 100 won't fit; the best mix by minutes is a+c = 90.
    s = scenario([
        {"id": "a", "duration": 60, "section": "ops"},
        {"id": "b", "duration": 50, "section": "ops"},
        {"id": "c", "duration": 30, "section": "ops"},
    ], horizon=100)
    out = solve_fill(s)
    assert out["status"] == "OPTIMAL"
    kept = {x["id"] for x in out["schedule"]}
    assert kept == {"a", "c"}
    assert out["left_out"] == ["b"]
    sec = out["fill"]["sections"]["ops"]
    assert (sec["used"], sec["pct"], sec["left"]) == (90, 90.0, 10)
    assert out["fill"]["overall"]["overflow"] == 50  # b's minutes wanted more horizon


def test_everything_fits_when_there_is_room():
    s = scenario([
        {"id": "a", "duration": 60, "section": "ops"},
        {"id": "b", "duration": 50, "section": "ops"},
    ], horizon=200)
    out = solve_fill(s)
    assert out["left_out"] == []
    assert out["fill"]["overall"]["used"] == 110
    assert out["fill"]["overall"]["overflow"] == 0


def test_constraints_still_hold_and_go_vacuous_on_dropped():
    # a->b precedence; only one fits. The packer keeps the bigger one and the
    # precedence goes vacuous instead of blocking the whole plan.
    s = scenario([
        {"id": "a", "duration": 50, "section": "s"},
        {"id": "b", "duration": 40, "section": "s"},
    ], [{"id": "c1", "type": "precedence", "before": "a", "after": "b", "enabled": True}],
        horizon=60)
    out = solve_fill(s)
    assert {x["id"] for x in out["schedule"]} == {"a"}
    assert out["left_out"] == ["b"]

    # With room for both, the precedence must actually order them.
    s2 = scenario([
        {"id": "a", "duration": 50, "section": "s"},
        {"id": "b", "duration": 40, "section": "s"},
    ], [{"id": "c1", "type": "precedence", "before": "a", "after": "b", "enabled": True}],
        horizon=120)
    out2 = solve_fill(s2)
    times = {x["id"]: x for x in out2["schedule"]}
    assert times["a"]["end"] <= times["b"]["start"]


def test_section_budget_caps_the_packing():
    s = scenario([
        {"id": "a", "duration": 60, "section": "lab"},
        {"id": "b", "duration": 50, "section": "lab"},
    ], [{"id": "c1", "type": "section_budget", "section": "lab", "max_minutes": 80,
         "enabled": True}], horizon=1440)
    out = solve_fill(s)
    assert out["fill"]["sections"]["lab"]["used"] <= 80
    assert {x["id"] for x in out["schedule"]} == {"a"}  # 60 beats 50 under the 80 cap


def test_recurring_occurrences_pack_per_day():
    s = scenario([
        {"id": "daily", "duration": 1000, "recurs_daily": True},
        {"id": "extra", "duration": 500},
    ], [{"id": "c1", "type": "no_overlap", "activities": "all", "enabled": True}],
        horizon=1440)
    out = solve_fill(s)
    # One day: daily#d1 (1000) + extra (500) = 1500 > 1440 -> keep the 1000.
    assert {x["id"] for x in out["schedule"]} == {"daily#d1"}
    assert out["left_out"] == ["extra"]


def test_no_section_bucket_is_reported():
    s = scenario([{"id": "a", "duration": 60}], horizon=120)
    out = solve_fill(s)
    assert out["fill"]["sections"]["(no section)"]["used"] == 60


def test_lake_example_fills_completely():
    lake = Scenario.model_validate(json.loads((EXAMPLES / "lake.json").read_text(encoding="utf-8")))
    out = solve_fill(lake)
    assert out["status"] in ("OPTIMAL", "FEASIBLE")
    assert out["left_out"] == []  # the lake day has room for everything


def test_fill_respects_conditional_duration_rules():
    # Regression: fill once minted a fresh presence var per occurrence, orphaning a
    # duration rule's trigger bool — sail came back at 240 min WITH kiteboard scheduled.
    # The rule ("if no kiteboard, sail x2") must hold in fill mode too.
    lake = Scenario.model_validate(json.loads((EXAMPLES / "lake.json").read_text(encoding="utf-8")))
    out = solve_fill(lake)
    sail = next(s for s in out["schedule"] if s["id"] == "sail")
    kite_scheduled = any(s["id"] == "kiteboard" for s in out["schedule"])
    if kite_scheduled:
        assert sail["end"] - sail["start"] == 120
    else:
        assert sail["end"] - sail["start"] == 240


def test_fill_report_keeps_empty_sections_and_caps_parallel_bucket():
    # A section whose activities were ALL left out must still show up (used 0), and
    # the "(no section)" bucket counts a merged union, so parallel activities can't
    # push it past 100%.
    s = scenario([
        {"id": "big", "duration": 200, "section": "lab"},   # can never fit 100
        {"id": "p1", "duration": 90},                        # no section: may overlap p2
        {"id": "p2", "duration": 90},
    ], horizon=100)
    out = solve_fill(s)
    assert out["fill"]["sections"]["lab"] == {"capacity": 100, "used": 0, "pct": 0.0, "left": 100}
    none = out["fill"]["sections"]["(no section)"]
    assert none["used"] <= 100 and none["left"] >= 0


def test_fill_bounds_on_a_dropped_activity_go_vacuous():
    # An impossible time_window used to wipe the var domains and sink the WHOLE fill;
    # now the bound is gated on presence, so the packer just leaves that activity out.
    s = scenario([
        {"id": "ok", "duration": 60, "section": "s"},
        {"id": "broken", "duration": 60, "section": "s"},
    ], [{"id": "c1", "type": "time_window", "activity": "broken", "earliest": "23:00",
         "latest_end": "01:00", "enabled": True}], horizon=120)
    out = solve_fill(s)
    assert out["status"] in ("OPTIMAL", "FEASIBLE")
    assert {x["id"] for x in out["schedule"]} == {"ok"}
    assert out["left_out"] == ["broken"]


def test_fill_route(client, lake):
    r = client.post("/fill", json=lake.model_dump())
    assert r.status_code == 200
    data = r.get_json()
    assert data["status"] in ("OPTIMAL", "FEASIBLE")
    assert "fill" in data and "left_out" in data
    r = client.post("/fill", json={"activities": "nope"})
    assert r.status_code == 400
