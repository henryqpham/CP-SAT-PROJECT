"""Read-only loaders for source data and scenarios.

Open files in read mode only — never write to data/. That's the "source stays untouched" rule.
"""

from __future__ import annotations

from pathlib import Path

from .models import Activity, FixedEvent, Scenario


def time_to_minutes(value: str) -> int:
    # "HH:MM" -> minutes since midnight.
    raise NotImplementedError


def minutes_to_time(minutes: int) -> str:
    # minutes since midnight -> "HH:MM".
    raise NotImplementedError


def load_activities(path: Path | None = None) -> list[Activity]:
    # Read activities.yaml (default: data/source/) and return a list of Activity.
    raise NotImplementedError


def load_fixed_events(path: Path | None = None) -> list[FixedEvent]:
    # Read fixed_events.yaml and return a list of FixedEvent.
    raise NotImplementedError


def load_source() -> tuple[list[Activity], list[FixedEvent]]:
    # Load both source files: return (activities, fixed_events).
    raise NotImplementedError


def scenario_path(name_or_path: str | Path) -> Path:
    # Resolve a scenario name to data/scenarios/<name>.yaml (or pass through an existing path).
    raise NotImplementedError


def load_scenario(name_or_path: str | Path) -> Scenario:
    # Read a scenario YAML and return a Scenario.
    raise NotImplementedError


def list_scenarios() -> list[str]:
    # Return scenario names (filenames without .yaml) in data/scenarios/.
    raise NotImplementedError
