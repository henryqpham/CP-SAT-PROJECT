"""Diff two solved schedules to see what CP-SAT moved when a rule changed."""

from __future__ import annotations

from .models import ScheduleResult


def diff_results(result_a: ScheduleResult, result_b: ScheduleResult) -> list:
    # Per-item start-time differences (b - a). Build name -> start maps and compare.
    raise NotImplementedError


def format_diff(result_a: ScheduleResult, result_b: ScheduleResult) -> str:
    # Render the diff as a readable table (item, start A, start B, delta).
    raise NotImplementedError
