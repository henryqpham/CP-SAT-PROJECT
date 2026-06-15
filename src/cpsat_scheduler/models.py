"""Data structures shared across the package.

Store clock times as minutes since midnight (int) — that's what CP-SAT works with.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Activity:
    """A flexible activity CP-SAT places in time."""

    # TODO: fields, e.g. name: str, duration_min: int, category: str, earliest_min, latest_min


@dataclass(frozen=True)
class FixedEvent:
    """An event pinned to a set time (meal, meeting) the solver works around."""

    # TODO: fields, e.g. name: str, start_min: int, duration_min: int, is_meal: bool


@dataclass(frozen=True)
class Scenario:
    """An editable rule set layered on the immutable source data."""

    # TODO: fields, e.g. name, day_start_min, day_end_min, exercise_gap_after_meal_min, objective


@dataclass(frozen=True)
class ScheduledItem:
    """One placed item in a solved schedule."""

    # TODO: fields, e.g. name, start_min, end_min, category, fixed: bool


@dataclass(frozen=True)
class ScheduleResult:
    """The outcome of solving one scenario."""

    # TODO: fields, e.g. scenario_name, status, feasible, objective_value, items: tuple[...]
