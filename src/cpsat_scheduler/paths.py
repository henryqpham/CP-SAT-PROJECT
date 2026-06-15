"""Filesystem locations for the project's data layers.

Resolved from this file's location (src/cpsat_scheduler/paths.py -> repo root), which works for
an editable install (`pip install -e .`). Override with the CPSAT_PROJECT_ROOT env var if you run
from somewhere else.
"""

from __future__ import annotations

import os
from pathlib import Path


def project_root() -> Path:
    override = os.environ.get("CPSAT_PROJECT_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


ROOT = project_root()
DATA_DIR = ROOT / "data"
SOURCE_DIR = DATA_DIR / "source"
SCENARIO_DIR = DATA_DIR / "scenarios"
RESULTS_DIR = ROOT / "results"
