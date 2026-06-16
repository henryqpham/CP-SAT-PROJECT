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

from models import Scenario


def solve(scenario: Scenario) -> dict:
    raise NotImplementedError("Write the CP-SAT model in solver.py")
