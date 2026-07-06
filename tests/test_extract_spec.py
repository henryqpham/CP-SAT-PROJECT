"""The requirements-spec extract pipeline on the committed sample .docx.

Uses the session fixtures from conftest: `sample_blocks` (ingest output) and
`extracted_sample` (ONE full extract_document run with ask=fail_ask — no LLM).
"""
import re

import pytest

import extract
import extract_det as det
from models import Scenario
from solver import explain_infeasible, solve


# --------------------------------------------------------------------------- #
# Coverage report — every [VR-xxx] accounted for, nothing dangling.
# --------------------------------------------------------------------------- #
def test_coverage_accounts_for_every_requirement(extracted_sample):
    cov = extracted_sample["coverage"]
    assert cov["n_in_doc"] == 29
    assert cov["n_extracted"] == 29
    assert cov["not_extracted"] == []
    assert cov["dangling_references"] == []
    assert cov["n_activities"] == 29
    assert cov["n_constraints"] == 35
    assert cov["horizon_days"] == 313
    assert cov["start_date"] == "2026-03-15"


def test_extraction_is_fully_deterministic(extracted_sample):
    # The sample spec resolves entirely by rules — zero model calls.
    ext = extracted_sample["coverage"]["extraction"]
    assert ext["by_method"] == {"deterministic": 29, "llm": 0, "default": 0}
    assert len(ext["resource"]["deterministic"]) == 29
    assert ext["dependencies"] == {"deterministic": 28, "llm": 0}
    assert ext["dated_deadlines"] == 7
    assert ext["llm_calls"] == 0
    assert ext["residual_requirements"] == []


def test_warnings_flag_self_loop_and_derived_start(extracted_sample):
    warnings = extracted_sample["warnings"]
    assert any("VR-512 depends on itself" in w for w in warnings)
    assert any("Project start derived as 2026-03-15" in w for w in warnings)


# --------------------------------------------------------------------------- #
# The scenario is valid IR with provenance carried end-to-end.
# --------------------------------------------------------------------------- #
def test_scenario_validates_with_provenance(extracted_sample):
    scenario = Scenario.model_validate(extracted_sample["scenario"])
    ids = {a.id for a in scenario.activities}
    assert "vr_110" in ids
    # ids are the norm_id form: "VR-110" -> "vr_110"
    assert all(re.fullmatch(r"vr_\d+", a.id) for a in scenario.activities)
    for a in scenario.activities:
        assert a.label
        assert a.source
    # every constraint keeps the phrase it came from
    for c in scenario.constraints:
        assert c.source


def test_deadlines_carry_day_and_priority(extracted_sample):
    scenario = Scenario.model_validate(extracted_sample["scenario"])
    deadlines = [c for c in scenario.constraints if c.type == "time_window"]
    assert len(deadlines) == 7
    for c in deadlines:
        assert c.day is not None and c.day >= 0
        assert c.latest_end
    # a "shall" deadline is graded hard (priority 1)
    shall = [c for c in deadlines if "shall" in c.source]
    assert shall
    assert shall[0].priority == 1


@pytest.mark.parametrize("text,priority", [
    ("The system shall log the event", 1),
    ("The build must be qualified first", 1),
    ("The check should run weekly", 3),
    ("This step may be skipped", 5),
    ("no keyword here", 1),
])
def test_infer_priority(text, priority):
    assert extract.infer_priority(text) == priority


# --------------------------------------------------------------------------- #
# The planted infeasibility. ONE test: explain_infeasible is O(n) re-solves.
# --------------------------------------------------------------------------- #
def test_planted_self_loop_is_the_whole_conflict(extracted_sample):
    scenario = Scenario.model_validate(extracted_sample["scenario"])
    assert solve(scenario)["status"] == "INFEASIBLE"

    # the minimal conflict is exactly the vr_512 -> vr_512 self-loop precedence
    assert explain_infeasible(scenario) == {"structural": False, "conflict_ids": ["c16"]}
    c16 = {c.id: c for c in scenario.constraints}["c16"]
    assert c16.type == "precedence"
    assert c16.before == c16.after == "vr_512"

    # Disable it and the plan solves. NOTE: the doc's SECOND planted conflict (the
    # VR-1012 deadline chain) does NOT bind — the derived start sits 153 days before
    # the 2026-08-15 freeze, which is plenty of runway for the ~37-day chain.
    for c in scenario.constraints:
        if c.id == "c16":
            c.enabled = False
    assert solve(scenario)["status"] == "OPTIMAL"
    assert explain_infeasible(scenario) == {"structural": False, "conflict_ids": []}


# --------------------------------------------------------------------------- #
# extract_det unit bits — pure functions, no fixtures.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("text,minutes", [
    ("Estimated validation effort: 3 days.", 4320),
    ("This activity shall take approximately 24 hours.", 1440),
    ("Allow 1 week for the test.", 10080),
    ("No effort is stated here.", None),
])
def test_parse_duration(text, minutes):
    assert det.parse_duration(text) == minutes


def test_parse_resource_forms():
    assert det.parse_resource("Requires the shared HIL test bench.") == "hil_test_bench"
    assert det.parse_resource("Conducted on the proving ground.") == "proving_ground"
    assert det.parse_resource("Owner: Chassis Team.") == "chassis_team"
    assert det.parse_resource("The system logs every event.") is None


def test_dependency_narration_guard():
    # "after [X] is <verb>" is narration, never a prerequisite edge
    narration = {"VR-300": {"text": "The panel is checked after [VR-200] is photographed."}}
    assert det.dependency_edges(narration) == []
    # an explicit "depends on [X]" IS one
    dep = {"VR-300": {"text": "This activity depends on [VR-200]."}}
    edges = det.dependency_edges(dep)
    assert [(b, a) for b, a, _phrase in edges] == [("VR-200", "VR-300")]


def test_norm_id_and_snake():
    assert det.norm_id("VR-110") == "vr_110"
    assert det.snake("HIL Test Bench") == "hil_test_bench"
    assert det.snake("Chassis Team") == "chassis_team"
