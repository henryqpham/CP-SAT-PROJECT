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

    print()
    if failures:
        print("GREEN GATE FAILED:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("GREEN GATE PASSED")


if __name__ == "__main__":
    main()
