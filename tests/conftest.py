"""Shared fixtures for the test suite.

Run everything with `python run_tests.py` from the repo root (backend + UI),
or just the backend with `python -m pytest`.
"""
import json
import sys
from pathlib import Path

import pytest

# Tests import the app modules (models, solver, ...) straight from the repo root.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from models import Scenario  # noqa: E402

EXAMPLES = ROOT / "examples"
TESTDATA = ROOT / "testdata"


def load_example(name: str) -> Scenario:
    """A fresh Scenario from examples/<name>.json (fresh each call, safe to mutate)."""
    return Scenario.model_validate(json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8")))


def fail_ask(prompt):
    """Injectable `ask` that proves the LLM was never needed (deterministic-only paths)."""
    raise AssertionError("the local model was called — expected a fully deterministic path")


@pytest.fixture
def lake():
    return load_example("lake")


@pytest.fixture
def lake_infeasible():
    return load_example("lake_infeasible")


@pytest.fixture
def nasa():
    return load_example("nasa_mission_3day")


@pytest.fixture(scope="session")
def sample_docx_bytes():
    return (TESTDATA / "sample_vehicle_requirements.docx").read_bytes()


@pytest.fixture(scope="session")
def sample_blocks(sample_docx_bytes):
    from ingest import extract_blocks
    return extract_blocks(sample_docx_bytes)


@pytest.fixture(scope="session")
def extracted_sample(sample_blocks):
    """The sample spec run through the whole extract pipeline, no LLM.
    Session-scoped (extraction is deterministic); don't mutate it — copy first."""
    from extract import extract_document
    return extract_document(sample_blocks["blocks"], ask=fail_ask)


@pytest.fixture
def client():
    from app import app
    app.config["TESTING"] = True
    return app.test_client()
