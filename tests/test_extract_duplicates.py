"""Duplicate requirement definitions: merged (first definition wins) but never silent.

A doc that defines the same [XX-nnn] twice — template docs pasted in sections do this —
may carry DIFFERENT values in each copy. The extractor keeps the first definition, and
the coverage report + warnings must say so, or the review modal looks clean over a
quietly mangled read (the testdoc.docx bug: 49 blocks in, 37 out, zero notice).
"""
import extract


def _blocks(texts):
    """Minimal ingest-shaped blocks (only the fields the extractor reads)."""
    return [{"index": i, "kind": "paragraph", "section_path": [], "text": t,
             "is_shall": " shall " in f" {t} "}
            for i, t in enumerate(texts)]


def _noop_ask(_prompt):
    return {"tasks": []}


DOC = [
    "[SH-900] First Task",
    "The system shall do the first thing. Plan: Estimated duration: 2 hours. Owner: AAA.",
    "[SH-901] Only Once",
    "The system shall run once. Plan: Estimated duration: 1 hour. Owner: AAA.",
    "[SH-900] Renamed Copy Of The Same Id",
    "The system shall do it differently. Plan: Estimated duration: 3 hours. Owner: BBB.",
]


def test_duplicate_ids_are_flagged_in_coverage_and_warnings():
    out = extract.extract_document(_blocks(DOC), ask=_noop_ask)
    assert out["coverage"]["duplicate_ids"] == ["SH-900"]
    assert any("defined more than once" in w and "SH-900" in w for w in out["warnings"])


def test_first_definition_wins_on_duplicate():
    out = extract.extract_document(_blocks(DOC), ask=_noop_ask)
    acts = {a["id"]: a for a in out["scenario"]["activities"]}
    assert len(acts) == 2  # two unique ids, not three activities
    assert acts["sh_900"]["label"] == "First Task"
    assert acts["sh_900"]["duration"] == 120  # copy 1's "2 hours", not copy 2's "3 hours"


def test_no_duplicates_means_empty_list():
    out = extract.extract_document(_blocks(DOC[:4]), ask=_noop_ask)
    assert out["coverage"]["duplicate_ids"] == []
    assert not any("defined more than once" in w for w in out["warnings"])
