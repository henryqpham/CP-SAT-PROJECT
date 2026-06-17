# YOU write this — it's the CP-SAT you're here to learn.
#
# Input:  a validated models.Scenario.
# Output: a dict the dashboard renders. Use this shape so static/app.js works:
#   {"status": "OPTIMAL", "schedule": [{"id": "sail", "start": 600, "end": 720}, ...]}
#   {"status": "INFEASIBLE", "conflict": ["c1", "c2"]}   # optional: which rules clashed
#   (start/end are minutes from midnight; 600 = 10:00.)
#
# Translate each constraint by its "type" (skip any where enabled is false):
#   time_window  -> model.add(start >= earliest);  model.add(end <= latest_end)
#   no_overlap   -> model.add_no_overlap([intervals])
#   precedence   -> model.add(end_before <= start_after)
#   conditional  -> a BoolVar + model.add(...).only_enforce_if(...)
#
# CP-SAT toolbox: CpModel, new_int_var, new_fixed_size_interval_var, add_no_overlap,
# only_enforce_if, add_max_equality, minimize, CpSolver().solve(model).

from ortools.sat.python import cp_model

from models import Scenario

# Single-day horizon: every time is minutes from midnight, 0..1440 (24h).
DAY = 24 * 60  # 1440


def _to_minutes(hhmm: str) -> int:
    """'HH:MM' -> minutes from midnight. '10:00' -> 600, '21:00' -> 1260."""
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def solve(scenario: Scenario) -> dict:
    model = cp_model.CpModel()

    # One start var + one fixed-size interval per activity, keyed by id.
    # Bounding start to [0, DAY - duration] keeps each activity inside the day
    # (end <= 1440). That day-horizon cap is what makes the smoke test infeasible.
    starts = {}
    durations = {}
    intervals = {}
    for a in scenario.activities:
        starts[a.id] = model.new_int_var(0, DAY - a.duration, a.id)
        durations[a.id] = a.duration
        intervals[a.id] = model.new_fixed_size_interval_var(
            starts[a.id], a.duration, f"iv_{a.id}"
        )

    # Each activity's end is just the expression start + duration.
    def end(activity_id):
        return starts[activity_id] + durations[activity_id]

    for c in scenario.constraints:
        if not c.enabled:
            continue

        if c.type == "time_window":
            if c.activity not in starts:
                continue
            if c.earliest is not None:
                model.add(starts[c.activity] >= _to_minutes(c.earliest))
            if c.latest_end is not None:
                model.add(end(c.activity) <= _to_minutes(c.latest_end))

        elif c.type == "no_overlap":
            if c.activities == "all":
                ivs = list(intervals.values())
            else:
                ivs = [intervals[aid] for aid in c.activities if aid in intervals]
            if ivs:
                model.add_no_overlap(ivs)

        elif c.type == "precedence":
            if c.before in starts and c.after in starts:
                model.add(end(c.before) <= starts[c.after])

        # conditional (Sprint 2) and any unknown type: no-op so it can't crash.

    solver = cp_model.CpSolver()
    status = solver.solve(model)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        schedule = [
            {
                "id": a.id,
                "start": solver.value(starts[a.id]),
                "end": solver.value(starts[a.id]) + a.duration,
            }
            for a in scenario.activities
        ]
        return {"status": "OPTIMAL", "schedule": schedule}

    return {"status": "INFEASIBLE"}
