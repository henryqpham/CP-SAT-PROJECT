"""Acronym glossary -> section display labels.

Docs that name owners by acronym ("Owner: SRME") often carry their own glossary
("SRME — Synthetic Resource Modeling Engine"). The extractor reads it so timeline
lanes can show the real name instead of a cryptic lowercase code. Display-only:
the section ID stays the solver key.
"""
import extract
import extract_det as det


def _para(text, path=(), kind="paragraph"):
    return {"index": 0, "kind": kind, "section_path": list(path), "text": text,
            "is_shall": " shall " in f" {text} "}


def _noop_ask(_prompt):
    return {"tasks": []}


GLOSSARY_PATH = ["APPENDIX A — SYNTHETIC ACRONYMS AND ABBREVIATIONS"]


def test_parse_glossary_reads_dash_and_colon_lines():
    blocks = [
        _para("SRME — Synthetic Resource Modeling Engine", GLOSSARY_PATH),
        _para("MAR: Mission Archive Reservoir", GLOSSARY_PATH),
        _para("SRME — A Later Duplicate Is Ignored", GLOSSARY_PATH),
    ]
    g = det.parse_glossary(blocks)
    assert g["srme"] == "Synthetic Resource Modeling Engine"
    assert g["mar"] == "Mission Archive Reservoir"


def test_parse_glossary_ignores_lines_outside_glossary_sections():
    # The same line shape in a normal section is NOT a glossary entry.
    blocks = [_para("SRME — Synthetic Resource Modeling Engine", ["10.0 LOGISTICS"])]
    assert det.parse_glossary(blocks) == {}


def test_extract_carries_glossary_labels_for_used_sections_only():
    blocks = [
        _para("[SH-900] First Task"),
        _para("The system shall do it. Plan: Estimated duration: 2 hours. Owner: SRME."),
        _para("APPENDIX A — ACRONYMS", GLOSSARY_PATH, kind="heading"),
        _para("SRME — Synthetic Resource Modeling Engine", GLOSSARY_PATH),
        _para("VTCM — Virtual Transport Cadence Model", GLOSSARY_PATH),  # defined, never used
    ]
    out = extract.extract_document(blocks, ask=_noop_ask)
    # only the section an activity actually uses gets a label; vtcm is unused
    assert out["scenario"]["section_labels"] == {"srme": "Synthetic Resource Modeling Engine"}
