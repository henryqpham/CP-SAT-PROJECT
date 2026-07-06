"""The committed demo examples through the real solver."""
from conftest import load_example
from solver import solve


def test_lake_solves_optimal(lake):
    result = solve(lake)
    assert result["status"] == "OPTIMAL"
    # every activity lands on the schedule (the optional kiteboard is kept)
    scheduled = {item["source"] for item in result["schedule"]}
    assert scheduled == {a.id for a in lake.activities}


def test_lake_infeasible_is_infeasible(lake_infeasible):
    assert solve(lake_infeasible)["status"] == "INFEASIBLE"


def test_nasa_mission_solves_optimal(nasa):
    result = solve(nasa)
    assert result["status"] == "OPTIMAL"
    assert result["horizon"] == 4320  # 3 days


def test_smoke_late_departure_breaks_the_plan(lake):
    # CLAUDE.md smoke test: leave at 21:00 but be home by 22:00 -> impossible.
    window = next(c for c in lake.constraints
                  if c.type == "time_window" and c.activity == "drive_to_lake")
    window.earliest = "21:00"
    assert solve(lake)["status"] == "INFEASIBLE"


def test_manifest_names_all_exist(client):
    manifest = client.get("/examples").get_json()
    names = [entry["name"] for entry in manifest]
    assert names
    for name in names:
        load_example(name)  # file exists and validates as a Scenario
