"""The deep-read reader (extract_llm.py) with a stubbed model — no Ollama needed.

The reader's contract: chunk the raw text (no structure assumed), collect typed notes
per chunk, then consolidate into IR-shaped PROPOSALS resolved against the deterministic
extraction. Proposals only — nothing writes into the scenario; unmodelable statements
land in couldnt_model instead of vanishing.
"""
import extract_llm as llm
from models import Scenario


def _blocks(texts):
    return [{"index": i, "kind": "paragraph", "section_path": [], "text": t, "is_shall": False}
            for i, t in enumerate(texts)]


# --------------------------------------------------------------------------- #
# Chunking
# --------------------------------------------------------------------------- #
def test_chunker_covers_all_text_with_overlap():
    blocks = _blocks([f"block {i} " + ("word " * 120) for i in range(20)])
    chunks = llm.chunk_blocks(blocks, chunk_words=300, overlap_words=100)
    assert len(chunks) > 1
    # every block's text appears in at least one chunk
    joined = "\n".join(c["text"] for c in chunks)
    for i in range(20):
        assert f"block {i} " in joined
    # consecutive chunks overlap (the second starts before the first ends)
    for a, b in zip(chunks, chunks[1:]):
        assert b["first_block"] <= a["last_block"]


def test_chunker_single_small_doc_is_one_chunk():
    chunks = llm.chunk_blocks(_blocks(["short text", "more text"]))
    assert len(chunks) == 1
    assert chunks[0]["first_block"] == 0


# --------------------------------------------------------------------------- #
# read_document with a stubbed ask
# --------------------------------------------------------------------------- #
def test_read_document_collects_notes_and_counts_calls():
    calls = []
    def fake_ask(prompt):
        calls.append(prompt)
        return {"activities": [], "relations": [], "unmodeled": []}
    r = llm.read_document(_blocks(["hello world"]), ask=fake_ask)
    assert r["calls"] == len(calls) == 1
    assert r["errors"] == []


def test_read_document_ollama_down_stops_with_one_error():
    def dead_ask(prompt):
        raise RuntimeError("Could not reach local Ollama model")
    r = llm.read_document(_blocks(["a " * 900, "b " * 900]), ask=dead_ask)
    assert r["calls"] == 0
    assert len(r["errors"]) == 1  # one clear outage message, not one per chunk
    assert "Ollama" in r["errors"][0]


# --------------------------------------------------------------------------- #
# Consolidation
# --------------------------------------------------------------------------- #
SCENARIO = {
    "activities": [
        {"id": "sh_901", "duration": 60, "label": "Synthetic Hazard Detection Sweep", "section": "shl"},
        {"id": "sh_902", "duration": 120, "label": "Contingency Behavior Execution Drill", "section": None},
    ],
    "constraints": [
        {"id": "c1", "type": "precedence", "before": "sh_901", "after": "sh_902", "enabled": True},
    ],
}


def _notes(activities=(), relations=(), unmodeled=()):
    return {"notes": [{"activities": list(activities), "relations": list(relations),
                       "unmodeled": list(unmodeled)}],
            "chunks": 1, "calls": 1, "errors": []}


def test_relation_by_name_resolves_to_existing_ids():
    r = _notes(relations=[{"kind": "before", "a": "Hazard Detection Sweep",
                           "b": "Contingency Behavior Execution Drill",
                           "evidence": "The sweep is completed before the drill."}])
    out = llm.consolidate(r, SCENARIO)
    # already captured deterministically (c1 says exactly this) -> dropped, not duplicated
    assert out["constraints"] == []


def test_new_relation_becomes_a_proposal_with_evidence():
    r = _notes(relations=[{"kind": "min_gap", "a": "hazard detection sweep",
                           "b": "contingency behavior execution drill", "gap_minutes": 30,
                           "evidence": "Allow 30 minutes between the sweep and the drill."}])
    out = llm.consolidate(r, SCENARIO)
    (c,) = out["constraints"]
    assert c["type"] == "min_separation" and c["gap"] == 30
    assert {c["a"], c["b"]} == {"sh_901", "sh_902"}
    assert c["source"].startswith("Allow 30 minutes")
    assert c["priority"] == 3  # model proposals are never P1


def test_reversed_precedence_is_a_disagreement_not_a_proposal():
    # SCENARIO's c1 says sh_901 before sh_902. The model (seen live with granite)
    # sometimes swaps direction — "sh_901 after sh_902" would plant a cycle if accepted.
    r = _notes(relations=[{"kind": "after", "a": "Hazard Detection Sweep",
                           "b": "Contingency Behavior Execution Drill",
                           "evidence": "…Performed after [SH-901]."}])
    out = llm.consolidate(r, SCENARIO)
    assert out["constraints"] == []
    assert any("OPPOSITE" in u["reason"] for u in out["couldnt_model"])


def test_unmatched_task_name_lands_in_couldnt_model():
    r = _notes(relations=[{"kind": "after", "a": "Totally Unknown Task", "b": "Hazard Detection Sweep",
                           "evidence": "The unknown task follows the sweep."}])
    out = llm.consolidate(r, SCENARIO)
    assert out["constraints"] == []
    assert any("couldn't match" in u["reason"] for u in out["couldnt_model"])


def test_new_activity_proposed_and_per_cycle_flagged():
    r = _notes(activities=[
        {"name": "Orbit Correction Burn", "duration_minutes": 45, "resource": "GNC",
         "recurrence": "none", "optionality": "shall", "evidence": "A 45-minute correction burn."},
        {"name": "Synthetic Hazard Detection Sweep", "duration_minutes": 60, "resource": None,
         "recurrence": "per_cycle", "optionality": "shall",
         "evidence": "The sweep runs at the start of each operational block."},
    ])
    out = llm.consolidate(r, SCENARIO)
    (a,) = out["activities"]  # the sweep matches an existing activity; only the burn is new
    assert a["id"] == "orbit_correction_burn"
    assert a["duration"] == 45 and a["section"] == "gnc"
    # the per-cycle reading on the EXISTING activity is surfaced, not silently dropped
    assert any("recurrence" in u["reason"] for u in out["couldnt_model"])


def test_proposals_validate_against_the_ir_when_merged():
    r = _notes(
        activities=[{"name": "Orbit Correction Burn", "duration_minutes": 45, "resource": None,
                     "recurrence": "daily", "optionality": "shall", "evidence": "e"}],
        relations=[{"kind": "not_concurrent", "a": "Hazard Detection Sweep",
                    "b": "Contingency Behavior Execution Drill", "evidence": "e2"}],
    )
    out = llm.consolidate(r, SCENARIO)
    merged = {
        "activities": SCENARIO["activities"] + [
            {k: v for k, v in a.items() if not k.startswith("_")} for a in out["activities"]],
        "constraints": SCENARIO["constraints"] + out["constraints"],
    }
    sc = Scenario.model_validate(merged)  # must not raise
    assert any(a.id == "orbit_correction_burn" and a.recurs_daily for a in sc.activities)
    assert any(c.type == "no_overlap" for c in sc.constraints)
