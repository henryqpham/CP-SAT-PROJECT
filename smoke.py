"""Green-gate smoke tests — the tripwire run after every change.

Runs the IR straight through solve() (no web layer, no Ollama) and asserts on
STATUS plus constraint SATISFACTION — never exact start times, which are
non-deterministic under the multi-day parallel solver. `verify_schedule` is the
real reliability check: it re-derives that every enabled constraint actually holds
in the returned schedule, so a silently-dropped rule fails the gate.

Run:  python smoke.py        (exit 0 = all green)
"""
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

from models import Scenario
from solver import explain_infeasibility, solve

ROOT = Path(__file__).resolve().parent
EXAMPLES = ROOT / "examples"


def _overlap(a, b):
    # Half-open intervals; touching end==start does NOT overlap.
    return a[0] < b[1] and b[0] < a[1]


def verify_schedule(scenario: Scenario, schedule: list, tol: int = 0) -> list[str]:
    """Return a list of constraint violations ([] means the schedule is valid).

    `tol` (minutes) absorbs the deliberate bucket-rounding loosening on time
    windows in multi-day mode; relational constraints (precedence, no_overlap) are
    exact and need no tolerance.
    """
    pos = {it["id"]: (it["start"], it["end"]) for it in schedule}
    errors = []

    for it in schedule:
        if it["end"] < it["start"]:
            errors.append(f"{it['id']}: end {it['end']} < start {it['start']}")

    def check_no_overlap(ids, what):
        present = [i for i in ids if i in pos]
        for i in range(len(present)):
            for j in range(i + 1, len(present)):
                if _overlap(pos[present[i]], pos[present[j]]):
                    errors.append(f"{what}: {present[i]} overlaps {present[j]}")

    for c in scenario.constraints:
        if not c.enabled:
            continue
        if c.type == "time_window":
            if c.activity not in pos:
                continue  # absent optional — fine
            s, e = pos[c.activity]
            if c.earliest is not None and s < c.earliest.to_minutes() - tol:
                errors.append(f"time_window {c.id}: {c.activity} starts {s} < earliest {c.earliest.to_minutes()}")
            if c.latest_end is not None and e > c.latest_end.to_minutes() + tol:
                errors.append(f"time_window {c.id}: {c.activity} ends {e} > latest_end {c.latest_end.to_minutes()}")
        elif c.type == "precedence":
            if c.before in pos and c.after in pos and pos[c.before][1] > pos[c.after][0]:
                errors.append(f"precedence {c.id}: {c.before} ends {pos[c.before][1]} > {c.after} starts {pos[c.after][0]}")
        elif c.type == "sequence":
            steps = [a for a in c.activities if a in pos]
            for before, after in zip(steps, steps[1:]):
                if before != after and pos[before][1] > pos[after][0]:
                    errors.append(f"sequence {c.id}: {before} ends after {after} starts")
        elif c.type == "no_overlap":
            ids = list(pos) if c.activities == "all" else c.activities
            check_no_overlap(ids, f"no_overlap {c.id}")

    # Auto resource no_overlap (mirror the solver).
    groups = defaultdict(list)
    for a in scenario.activities:
        if a.resource and a.id in pos:
            groups[a.resource].append(a.id)
    for res, ids in groups.items():
        check_no_overlap(ids, f"resource '{res}'")

    return errors


def _load(name):
    return Scenario.model_validate(json.loads((EXAMPLES / f"{name}.json").read_text()))


def regressions() -> list:
    """Locked-in checks for bugs found in the adversarial hardening pass — one per fix.
    Returns a list of failure strings ([] = all green). Runs offline (no Ollama, no .docx)."""
    import io
    import zipfile

    from pydantic import ValidationError

    import ingest
    from extract import extract_document, index_requirements
    from ingest import extract_blocks

    fails = []

    def check(name, cond, detail=""):
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            fails.append(f"{name}: {detail}")

    def mk(d):
        return Scenario.model_validate(d)

    def block(i, text):
        return {"index": i, "kind": "requirement", "section_path": ["S"], "text": text,
                "requirement_ids": [], "dates": [], "is_shall": False}

    none_ask = lambda p: {"tasks": [], "links": []}

    # solver A1: bucket rounding must NOT manufacture a false INFEASIBLE.
    r = solve(mk({"horizon_days": 1, "activities": [{"id": "a", "duration": 7}, {"id": "b", "duration": 1433}],
                  "constraints": [{"id": "n", "type": "no_overlap", "activities": "all"}]}))
    check("solver: 7+1433 fits a 1-day canvas", r["status"] in ("OPTIMAL", "FEASIBLE"), r["status"])

    # solver: single-day shared resources are enforced (serialized, not overlapping).
    sd = mk({"activities": [{"id": "x", "duration": 600, "resource": "rig"},
                            {"id": "y", "duration": 600, "resource": "rig"}], "constraints": []})
    check("solver: single-day resource serialized", not verify_schedule(sd, solve(sd).get("schedule", [])))

    # explainer: two independent causes still names the actionable logic core (not 'unknown').
    two = mk({"activities": [{"id": "task", "duration": 120}, {"id": "p", "duration": 800, "resource": "r"},
                             {"id": "q", "duration": 800, "resource": "r"}],
              "constraints": [{"id": "early", "type": "time_window", "activity": "task", "earliest": "21:00"},
                              {"id": "late", "type": "time_window", "activity": "task", "latest_end": "22:00"}]})
    cf = explain_infeasibility(two)
    check("explain: two-cause names logic core",
          bool(cf) and cf["kind"] == "logic" and {"early", "late"} <= {c["id"] for c in cf["constraints"]}, str(cf))

    # explainer: a FEASIBLE scenario must NOT get a fabricated conflict.
    feas = mk({"activities": [{"id": "z", "duration": 60, "resource": "r"}], "constraints": []})
    check("explain: feasible -> None", explain_infeasibility(feas) is None)

    # explainer: pure resource over-subscription -> kind 'resource'.
    rc = explain_infeasibility(mk({"horizon_days": 5,
        "activities": [{"id": f"t{i}", "duration": 2880, "resource": "rig"} for i in range(3)], "constraints": []}))
    check("explain: pure resource -> resource", bool(rc) and rc["kind"] == "resource", str(rc))

    # models: malformed Moment objects are rejected (not silently midnight).
    for bad in ({"day": 3}, {}, {"day": 3, "tinme": "09:00"}, {"day": 10 ** 9, "time": "09:00"}):
        try:
            mk({"activities": [{"id": "a", "duration": 1}],
                "constraints": [{"type": "time_window", "activity": "a", "earliest": bad}]})
            check(f"models: reject malformed Moment {bad}", False, "accepted")
        except ValidationError:
            check(f"models: reject malformed Moment {bad}", True)
    # ...and a day-0 Moment still serializes to a bare string (backward compat).
    lk = mk(json.loads((EXAMPLES / "lake.json").read_text())).model_dump()
    check("models: day-0 Moment -> bare string",
          next(c for c in lk["constraints"] if c["id"] == "c1")["earliest"] == "08:00")

    # extract: malformed model drafts degrade gracefully (no crash, valid scenario).
    simple = [block(0, "[VR-100] Alpha.")]
    for ask in ({"tasks": [{"req_id": "VR-100", "duration_minutes": float("inf")}], "links": []},
                {"tasks": "nope", "links": {"x": 1}},
                {"tasks": [{"req_id": "VR-100", "resource": 123, "label": 99999}], "links": [42]}):
        try:
            Scenario.model_validate(extract_document(simple, ask=lambda p, a=ask: a)["scenario"])
            check("extract: malformed draft survives", True)
        except Exception as e:
            check("extract: malformed draft survives", False, f"{type(e).__name__}: {e}")

    # extract: a year-0001 date must not crash date derivation.
    try:
        extract_document([block(0, "[VR-100] Alpha. Due 0001-01-01.")], ask=none_ask)
        check("extract: year-0001 date no crash", True)
    except Exception as e:
        check("extract: year-0001 date no crash", False, str(e))

    # extract: dependency regex ignores narration, keeps a real 'performed after'.
    narr = [block(0, "[VR-100] Inspect."), block(1, "Done after [VR-200] is photographed."), block(2, "[VR-200] Photo.")]
    e1 = [c for c in extract_document(narr, ask=none_ask)["scenario"]["constraints"] if c["type"] == "precedence"]
    check("extract: narration is not a dependency", e1 == [], str(e1))
    real = [block(0, "[VR-100] Alpha."), block(1, "[VR-200] Beta."), block(2, "Beta performed after [VR-100].")]
    e2 = [(c["before"], c["after"]) for c in extract_document(real, ask=none_ask)["scenario"]["constraints"] if c["type"] == "precedence"]
    check("extract: real 'performed after' is a dependency", ("vr_100", "vr_200") in e2, str(e2))

    # extract: a duplicate requirement definition merges (first body not discarded).
    dup = index_requirements([block(0, "[VR-1] A."), block(1, "Effort 5 days."),
                              block(2, "[VR-1] A again."), block(3, "Owner: Chassis.")])
    check("extract: duplicate def merges body",
          "5 days" in dup["VR-1"]["text"] and "Chassis" in dup["VR-1"]["text"])

    # --- deterministic-first refactor: one regression per new extractor ---
    import extract_det

    def kblock(i, text, kind="requirement"):
        return {"index": i, "kind": kind, "section_path": ["S"], "text": text,
                "requirement_ids": [], "dates": [], "is_shall": kind == "shall"}

    def boom(_p):  # the LLM must never be touched when rules resolve everything
        raise AssertionError("LLM called despite a fully deterministic document")

    # 1. Deterministic-first: a well-formed doc resolves with ZERO model calls.
    clean = [block(0, "[VR-1] Alpha."),
             block(1, "Estimated validation effort: 2 days. Requires the shared HIL test bench."),
             block(2, "[VR-2] Beta."),
             block(3, "Estimated effort: 1 day. Owner: Chassis. Depends on [VR-1].")]
    out = extract_document(clean, ask=boom)
    acts = {a["id"]: a for a in out["scenario"]["activities"]}
    ex = out["coverage"]["extraction"]
    edges = [(c["before"], c["after"]) for c in out["scenario"]["constraints"] if c["type"] == "precedence"]
    check("extract: rules resolve -> zero LLM calls", ex["llm_calls"] == 0 and len(acts) == 2, str(ex))
    check("extract: deterministic duration read", acts["vr_1"]["duration"] == 2880 and acts["vr_2"]["duration"] == 1440)
    check("extract: deterministic dependency edge", ("vr_1", "vr_2") in edges, str(edges))
    check("extract: resource precision (shared bench, not narrative)", acts["vr_1"]["resource"] == "hil_test_bench", acts["vr_1"]["resource"])

    # 2. Residual fallback: a requirement with no stated duration triggers exactly one
    #    scoped LLM call, and the value is tagged as model-resolved (never silently a guess).
    calls = {"n": 0}

    def ask_fill(_p):
        calls["n"] += 1
        return {"tasks": [{"req_id": "VR-3", "duration_minutes": 600, "resource": "lab"}], "links": []}

    gap = [block(0, "[VR-3] Gamma."), block(1, "This requirement states no effort and no owner.")]
    out = extract_document(gap, ask=ask_fill)
    a3 = out["scenario"]["activities"][0]
    check("extract: residual triggers one LLM call", calls["n"] == 1, str(calls))
    check("extract: residual LLM fills the gap", a3["duration"] == 600 and a3["resource"] == "lab")
    check("extract: residual duration tagged 'llm'", "VR-3" in out["coverage"]["extraction"]["duration"]["llm"])

    # 3. Heading-reset: a new section ENDS a requirement's body, so trailing content can't
    #    glue onto the last requirement and manufacture a false (self-)edge.
    bleed = [kblock(0, "[VR-1] Alpha."),
             kblock(1, "Estimated effort: 1 day. Owner: Chassis.", "text"),
             kblock(2, "5  PROGRAM MILESTONES", "heading"),
             kblock(3, "Validation shall not begin until [VR-1] is complete.", "shall")]
    e = [(c["before"], c["after"]) for c in extract_document(bleed, ask=boom)["scenario"]["constraints"] if c["type"] == "precedence"]
    check("extract: heading ends body (no cross-section false edge)", e == [], str(e))

    # 4. Dependencies stay deterministic through the fallback: even when the residual model
    #    asserts a precedence link (here for a narration "after [VR-x] is ..." ref), no edge is
    #    created — the model only fills missing fields; the narration ref is logged for review.
    def ask_assert_narration(_p):
        return {"tasks": [{"req_id": "VR-7", "duration_minutes": 300}],
                "links": [{"type": "precedence", "before": "VR-8", "after": "VR-7", "source": "x"}]}

    narr2 = [block(0, "[VR-7] Inspect."), block(1, "Done after [VR-8] is photographed."),
             block(2, "[VR-8] Photo."), block(3, "Estimated effort: 2 days. Owner: QA.")]
    out = extract_document(narr2, ask=ask_assert_narration)
    e = [(c["before"], c["after"]) for c in out["scenario"]["constraints"] if c["type"] == "precedence"]
    xref = out["coverage"]["extraction"]["cross_references"]
    check("extract: fallback cannot resurrect a narration edge", ("vr_8", "vr_7") not in e, str(e))
    check("extract: narration ref recorded for review", any(r["references"] == "VR-8" for r in xref["narrative"]), str(xref))

    # 5. Resource extractor precision: deliberate phrasings only; narrative "on the …" is gone.
    check("extract_det: resource reads the shared bench, not the shall narrative",
          extract_det.parse_resource("shall log events on the control bus. Requires the shared HIL test bench.") == "hil_test_bench")
    check("extract_det: resource reads the 'conducted on the' form",
          extract_det.parse_resource("Conducted on the environmental chamber.") == "environmental_chamber")

    # 6. Real 15-page doc, deterministic-only: full coverage, the verified 28 real edges,
    #    the planted self-loop, no guessed durations, and no residual (so no LLM is needed).
    doc = ROOT / "testdata" / "sample_vehicle_requirements.docx"
    if doc.exists():
        with open(doc, "rb") as f:
            db = extract_blocks(f)["blocks"]
        o = extract_document(db, ask=boom)
        cov, sc = o["coverage"], o["scenario"]
        de = [(c["before"], c["after"]) for c in sc["constraints"] if c["type"] == "precedence"]
        check("doc: 29/29 requirements, none dropped", cov["n_extracted"] == 29 and cov["not_extracted"] == [], str(cov.get("not_extracted")))
        check("doc: 28 real dependency edges (no cross-section false edge)", len(de) == 28, len(de))
        check("doc: planted self-loop survives", ("vr_512", "vr_512") in de)
        check("doc: zero defaulted durations (all read by rules)", cov["defaulted_duration"] == [], str(cov["defaulted_duration"]))
        check("doc: fully deterministic (no residual / no LLM call)",
              cov["extraction"]["residual_requirements"] == [] and cov["extraction"]["llm_calls"] == 0, str(cov["extraction"]))
    else:
        check("doc: sample present (run testdata/make_sample_docx.py)", False, "missing sample_vehicle_requirements.docx")

    # ingest: a zip bomb is refused (cap monkeypatched small to avoid a huge alloc here).
    cap = ingest.MAX_UNCOMPRESSED_BYTES
    ingest.MAX_UNCOMPRESSED_BYTES = 1000
    try:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("word/document.xml", b"A" * 5000)
        try:
            extract_blocks(io.BytesIO(buf.getvalue()))
            check("ingest: zip bomb refused", False, "not refused")
        except ValueError:
            check("ingest: zip bomb refused", True)
    finally:
        ingest.MAX_UNCOMPRESSED_BYTES = cap

    # upload: file parts stay in memory (BytesIO), never spooled to disk.
    import app as appmod
    stream = appmod._InMemoryRequest._get_file_stream(None, 0, "application/octet-stream", "x.docx", 0)
    check("upload: file parts stay in memory", isinstance(stream, io.BytesIO))

    return fails


def main():
    failures = []

    # 1. lake.json must be OPTIMAL and satisfy every constraint (single-day path).
    lake = _load("lake")
    r = solve(lake)
    errs = verify_schedule(lake, r.get("schedule", []))
    if r["status"] != "OPTIMAL":
        failures.append(f"lake: expected OPTIMAL, got {r['status']}")
    if errs:
        failures.append(f"lake: schedule violates constraints: {errs}")
    print(f"[{'PASS' if r['status'] == 'OPTIMAL' and not errs else 'FAIL'}] lake -> {r['status']}")

    # 2. Tight window must be INFEASIBLE (drive_to_lake earliest 21:00, home by 22:00).
    d = json.loads((EXAMPLES / "lake.json").read_text())
    for c in d["constraints"]:
        if c["id"] == "c1":
            c["earliest"] = "21:00"
    tight = Scenario.model_validate(d)
    r = solve(tight)
    if r["status"] != "INFEASIBLE":
        failures.append(f"tight: expected INFEASIBLE, got {r['status']}")
    print(f"[{'PASS' if r['status'] == 'INFEASIBLE' else 'FAIL'}] tight -> {r['status']}")

    # 3. project.json (multi-day) must solve and satisfy every constraint.
    proj = _load("project")
    r = solve(proj)
    tol = int(os.environ.get("SOLVER_BUCKET_MINUTES", 15))
    errs = verify_schedule(proj, r.get("schedule", []), tol=tol)
    ok = r["status"] in ("OPTIMAL", "FEASIBLE") and not errs
    if r["status"] not in ("OPTIMAL", "FEASIBLE"):
        failures.append(f"project: expected OPTIMAL/FEASIBLE, got {r['status']}")
    if errs:
        failures.append(f"project: schedule violates constraints: {errs}")
    print(f"[{'PASS' if ok else 'FAIL'}] project -> {r['status']} (horizon {r.get('horizon')}m, {len(r.get('schedule', []))} tasks)")

    # 4. A resource-free single-day scenario must gain zero auto no_overlaps
    #    (sanity: the resource feature doesn't perturb existing scenarios).
    assert lake.is_multi_day is False, "lake should not be multi-day"

    # 5. Infeasibility explanation: tight (single-day) must name a conflict that
    #    includes the deadline/earliest time windows that make it impossible.
    conflict = explain_infeasibility(tight)
    ids = {c["id"] for c in (conflict or {}).get("constraints", [])}
    ok = bool(conflict) and conflict["kind"] in ("logic", "resource") and ("c1" in ids or "c2" in ids)
    if not ok:
        failures.append(f"explain(tight): expected a conflict naming c1/c2, got {conflict}")
    print(f"[{'PASS' if ok else 'FAIL'}] explain(tight) -> {conflict['kind'] if conflict else None} {sorted(ids)}")

    # 6. Multi-day logic conflict: a self-dependency (A before A) must be pinpointed.
    cyc = Scenario.model_validate({
        "horizon_days": 5,
        "activities": [{"id": "a", "duration": 600}, {"id": "b", "duration": 600}],
        "constraints": [{"id": "loop", "type": "precedence", "before": "a", "after": "a"}],
    })
    c2 = explain_infeasibility(cyc)
    ids2 = {c["id"] for c in (c2 or {}).get("constraints", [])}
    ok2 = bool(c2) and c2["kind"] == "logic" and "loop" in ids2
    if not ok2:
        failures.append(f"explain(self-loop): expected logic conflict naming 'loop', got {c2}")
    print(f"[{'PASS' if ok2 else 'FAIL'}] explain(self-loop) -> {c2['kind'] if c2 else None} {sorted(ids2)}")

    # --- regression suite (bugs fixed in the adversarial hardening pass) ---
    print("\n-- regressions --")
    failures += regressions()

    print()
    if failures:
        print("GREEN GATE FAILED:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("GREEN GATE PASSED")


if __name__ == "__main__":
    main()
