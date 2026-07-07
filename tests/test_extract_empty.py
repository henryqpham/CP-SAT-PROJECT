"""The 'bad doc' path: a valid .docx the extractor finds nothing schedulable in.

Instead of a silent empty plan, the coverage report should carry a near-miss id hint
when the cause is a wrong id separator ("[SH 801]" instead of the hyphen-strict "[SH-801]"),
so the review modal can say "did you mean [SH-801]?" and refuse to load an empty plan.
"""
import extract
import extract_det as det


def _blocks(texts, kinds=None):
    """Minimal ingest-shaped blocks (only the fields the extractor reads)."""
    return [{"index": i, "kind": (kinds[i] if kinds else "paragraph"),
             "section_path": [], "text": t, "is_shall": " shall " in f" {t} "}
            for i, t in enumerate(texts)]


def _noop_ask(_prompt):
    return {"tasks": []}  # no Ollama; the residual model finds nothing


def test_space_separated_ids_are_near_misses():
    blocks = _blocks(["[SH 801] Synthetic Resupply Availability Projection"])
    nm = det.find_near_miss_ids(blocks)
    assert nm is not None
    assert nm["count"] == 1
    assert nm["example_found"] == "[SH 801]"
    assert nm["example_fixed"] == "[SH-801]"


def test_underscore_and_no_separator_ids_are_near_misses():
    nm = det.find_near_miss_ids(_blocks(["[SH_801] a", "[VR1012] b"]))
    assert nm["count"] == 2
    assert set(nm["samples"]) == {"[SH_801]", "[VR1012]"}


def test_correct_hyphenated_ids_are_not_near_misses():
    # The hyphen is the contract — a correct id must never be flagged as a near-miss.
    assert det.find_near_miss_ids(_blocks(["[SH-801] proper id", "[VR-1012] also fine"])) is None


def test_placeholder_lines_do_not_trip_the_hint():
    # "[FIGURE 10 1 Placeholder ...]" has trailing words, not a closing bracket after the number.
    assert det.find_near_miss_ids(_blocks(["[FIGURE 10 1 Placeholder — diagram omitted]"])) is None


def test_empty_extraction_attaches_the_hint():
    blocks = _blocks([
        "[SH 801] Synthetic Resupply Availability Projection",
        "The system shall generate a projection. Estimated duration: 1 hour.",
        "[SH 802] Virtual Transport Cadence Optimization Pass",
        "The system shall run a pass. Estimated duration: 2 hours.",
    ])
    out = extract.extract_document(blocks, ask=_noop_ask)
    assert out["scenario"]["activities"] == []      # nothing was schedulable
    nm = out["coverage"]["near_miss_ids"]
    assert nm["count"] == 2
    assert nm["example_fixed"] == "[SH-801]"


def test_good_doc_has_no_near_miss_key():
    blocks = _blocks([
        "[SH-801] Synthetic Resupply Availability Projection",
        "The system shall generate a projection. Estimated duration: 1 hour.",
    ])
    out = extract.extract_document(blocks, ask=_noop_ask)
    assert out["scenario"]["activities"], "a well-formed doc still extracts"
    assert out["coverage"].get("near_miss_ids") is None
