"""Benchmark + regression harness for the document-extraction pipeline.

Measures the end-to-end cost and quality of `extract.extract_document` on the
synthetic 15-page spec, so the deterministic-first refactor's win is quantified
(not asserted). It wraps the local-model `ask` to count how many LLM calls the
pipeline actually makes and how many return unparseable JSON — the two numbers
that collapse when extraction goes deterministic-first.

Usage:
    python bench_extract.py                       # run, print a report
    python bench_extract.py --out results.json    # also dump machine-readable metrics
    python bench_extract.py --label after         # tag the run (before/after)
    python bench_extract.py --no-llm              # deterministic-only (skip Ollama)

Run before and after the refactor with the SAME doc to compare wall-clock,
LLM-call count, invalid-JSON rate, and that coverage stays 29/29 with the
planted conflict still proving INFEASIBLE.
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import extract  # noqa: E402
from ingest import extract_blocks  # noqa: E402
from models import Scenario  # noqa: E402
from solver import explain_infeasibility, solve  # noqa: E402

DOC = ROOT / "testdata" / "sample_vehicle_requirements.docx"


class _AskMeter:
    """Wrap the real local-model call to count invocations and JSON failures.

    A failure is a chunk the model could not return parseable JSON for — the
    exact thing the deterministic backbone has to compensate for. Latency is the
    time actually spent inside the model so we can separate it from regex work.
    """

    def __init__(self, inner):
        self.inner = inner
        self.calls = 0
        self.failures = 0
        self.model_seconds = 0.0

    def __call__(self, prompt):
        self.calls += 1
        t0 = time.perf_counter()
        try:
            return self.inner(prompt)
        except Exception:
            self.failures += 1
            raise
        finally:
            self.model_seconds += time.perf_counter() - t0


def run(label: str, use_llm: bool) -> dict:
    if not DOC.exists():
        raise SystemExit(
            f"Missing {DOC}. Generate it first: python testdata/make_sample_docx.py"
        )
    with open(DOC, "rb") as f:
        blocks = extract_blocks(f)["blocks"]

    # use_llm=False forces the deterministic path by handing the pipeline a no-op
    # model that returns nothing — proving the backbone stands on its own.
    inner = extract._ask_json if use_llm else (lambda _p: {"tasks": [], "links": []})
    meter = _AskMeter(inner)

    t0 = time.perf_counter()
    out = extract.extract_document(blocks, ask=meter)
    wall = time.perf_counter() - t0

    scenario = Scenario.model_validate(out["scenario"])
    cov = out["coverage"]
    edges = [c for c in out["scenario"]["constraints"] if c["type"] == "precedence"]

    # The planted conflicts must still make the project INFEASIBLE with a named cause.
    result = solve(scenario)
    conflict = explain_infeasibility(scenario) if result.get("status") == "INFEASIBLE" else None

    fail_rate = (meter.failures / meter.calls) if meter.calls else 0.0
    metrics = {
        "label": label,
        "use_llm": use_llm,
        "wall_seconds": round(wall, 3),
        "model_seconds": round(meter.model_seconds, 3),
        "llm_calls": meter.calls,
        "llm_json_failures": meter.failures,
        "llm_failure_rate": round(fail_rate, 4),
        "n_in_doc": cov.get("n_in_doc"),
        "n_extracted": cov.get("n_extracted"),
        "not_extracted": cov.get("not_extracted"),
        "defaulted_duration": cov.get("defaulted_duration"),
        "n_activities": cov.get("n_activities"),
        "n_constraints": cov.get("n_constraints"),
        "n_precedence_edges": len(edges),
        "solve_status": result.get("status"),
        "conflict_kind": (conflict or {}).get("kind"),
        # The deterministic-first refactor adds this; absent on the old pipeline.
        "extraction": cov.get("extraction"),
    }
    return metrics


def report(m: dict):
    print(f"\n=== extraction benchmark [{m['label']}] ===")
    print(f"  wall-clock        : {m['wall_seconds']:.2f} s")
    print(f"  time in model     : {m['model_seconds']:.2f} s")
    print(f"  LLM calls         : {m['llm_calls']}")
    print(f"  LLM JSON failures : {m['llm_json_failures']}  ({m['llm_failure_rate'] * 100:.1f}%)")
    print(f"  coverage          : {m['n_extracted']}/{m['n_in_doc']} requirements extracted")
    print(f"  not extracted     : {m['not_extracted']}")
    print(f"  defaulted duration: {m['defaulted_duration']}")
    print(f"  activities/edges  : {m['n_activities']} activities, {m['n_precedence_edges']} precedence edges")
    print(f"  solve             : {m['solve_status']}  (conflict: {m['conflict_kind']})")
    if m.get("extraction"):
        ex = m["extraction"]
        print(f"  resolved by       : {ex.get('by_method')}")
        print(f"  residual reqs     : {ex.get('residual_requirements')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="run")
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-llm", action="store_true")
    args = ap.parse_args()

    m = run(args.label, use_llm=not args.no_llm)
    report(m)
    if args.out:
        Path(args.out).write_text(json.dumps(m, indent=2))
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
