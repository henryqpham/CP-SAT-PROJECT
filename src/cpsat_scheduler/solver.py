"""Build a CP-SAT model from (source data + scenario) and solve it.

This is the heart of the project — the main thing to implement and learn.
"""

from __future__ import annotations

from .models import Activity, FixedEvent, Scenario, ScheduleResult

EXERCISE_CATEGORY = "exercise"


def build_and_solve(
    activities: list[Activity],
    fixed_events: list[FixedEvent],
    scenario: Scenario,
) -> ScheduleResult:
    # Implement step by step (see docs: developers.google.com/optimization/scheduling):
    #
    # 1. from ortools.sat.python import cp_model;  model = cp_model.CpModel()
    # 2. For each activity: a start IntVar + an interval var (model.new_interval_var).
    #    Apply its window with constraints.add_window.
    # 3. For each fixed event: a fixed interval (model.new_fixed_size_interval_var).
    # 4. constraints.add_no_overlap over all intervals.
    # 5. For exercise activities (category == EXERCISE_CATEGORY): constraints.add_meal_exercise_gap.
    # 6. Objective: e.g. minimize the latest end time (model.minimize / model.add_max_equality).
    # 7. solver = cp_model.CpSolver(); status = solver.solve(model).
    # 8. Read solver.value(start) for each activity and return a ScheduleResult.
    raise NotImplementedError
