"""Constraint builders — one function per scheduling rule.

Each is a thin wrapper around the cp_model API. Add a new rule = add a new function here and
call it from solver.build_and_solve.
"""

from __future__ import annotations

from ortools.sat.python import cp_model

from .models import Activity, FixedEvent


def add_window(
    model: cp_model.CpModel,
    start: cp_model.IntVar,
    activity: Activity,
    day_start_min: int,
    day_end_min: int,
) -> None:
    # Keep the activity inside the day and its own earliest/latest window.
    # Hint: model.add(start >= earliest); model.add(start + duration <= latest).
    raise NotImplementedError


def add_no_overlap(model: cp_model.CpModel, intervals: list[cp_model.IntervalVar]) -> None:
    # No two items at once. Hint: model.add_no_overlap(intervals).
    raise NotImplementedError


def add_meal_exercise_gap(
    model: cp_model.CpModel,
    activity: Activity,
    start: cp_model.IntVar,
    meals: list[FixedEvent],
    gap_min: int,
) -> None:
    # No exercise within gap_min after a meal ends.
    # For each meal, either finish before it starts OR start >= meal end + gap_min.
    # Hint: a reified bool + two `.only_enforce_if(...)` constraints models the OR.
    raise NotImplementedError
