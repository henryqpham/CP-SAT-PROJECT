"""Run a scenario end-to-end and persist its result under results/."""

from __future__ import annotations

from pathlib import Path

from .models import ScheduleResult


def run_scenario(name_or_path: str | Path) -> ScheduleResult:
    # Load source + scenario, then call solver.build_and_solve. Return the result (no disk write).
    raise NotImplementedError


def result_to_dict(result: ScheduleResult) -> dict:
    # JSON-friendly view of a result (store times as minutes and/or "HH:MM").
    raise NotImplementedError


def result_from_dict(data: dict) -> ScheduleResult:
    # Rebuild a ScheduleResult from result_to_dict output.
    raise NotImplementedError


def save_result(result: ScheduleResult, results_dir: Path | None = None) -> Path:
    # Write results/<scenario_name>.json and return the path.
    raise NotImplementedError


def load_result(name_or_path: str | Path, results_dir: Path | None = None) -> ScheduleResult:
    # Read a previously saved result by scenario name (or explicit path).
    raise NotImplementedError
