"""Deterministic-first extraction: a large .docx's structured blocks -> one validated multi-day Scenario.

A controlled requirements document states its scheduling signal structurally — "[VR-110]"
headers, "Estimated validation effort: 3 days", "Owner: Chassis Team", "depends on [VR-110]",
dated milestones. So we read it with RULES first (extract_det.py) and call the local LLM ONLY
for the residue rules can't resolve. Pipeline (all local, privacy-preserving):

    index every [VR-xxx] definition (the backbone — nothing can be silently dropped)
      -> DETERMINISTIC pass: duration, resource, dependencies, dated deadlines, by regex
      -> RESIDUAL pass: the local Ollama model fills ONLY a missing duration/resource a rule
         couldn't read (it never creates dependency edges — those stay deterministic)
      -> merge into one activity per [VR-xxx], deduped, with an extraction-method tag per field
      -> reconciliation / coverage report (every [VR-xxx] accounted for; dangling refs flagged)

Why deterministic-FIRST: the whole-document LLM map-reduce took minutes and the small local
model returns invalid JSON for a large fraction of dense chunks. For a well-formed spec the
rules resolve essentially everything, so the LLM runs on a tiny residual (often zero) — minutes
collapse to seconds — WITHOUT weakening reliability: every dependency edge is deterministic and
authoritative (the narrow regex's narration guard is never reopened by the fallback), and the
coverage report now records HOW each item was resolved (deterministic / llm / default), making
the trust story stronger. `extract_document` takes an injectable `ask` so the whole pipeline is
unit-testable without Ollama.
"""
import json
import math
import re

import ollama

import extract_det as det
import extract_sched
from extract_det import index_requirements  # re-exported: part of the module's public surface
from models import Scenario
from parse import MODEL  # reuse the same local model + OLLAMA_MODEL override

DEFAULT_DURATION_MIN = 480  # 1 working day, when nothing else is stated (flagged in coverage)
MAX_DURATION_MIN = 365 * 24 * 60  # clamp absurd model durations to a sane ceiling
RESIDUAL_MAX_CHARS = 6000  # batch residual requirements so a fallback prompt never truncates

# RFC 2119 modal keywords -> constraint priority (1 = hardest/inviolable … 5 = droppable first). A
# requirements doc grades obligation with these words, so mapping them lets the priority-ordered
# relaxation drop a "should"/"may" rule before a "shall"/"must" one. No keyword -> stays hard (1), so
# nothing is silently softened. This is the ONLY place the doc path sets priority — tune it here.
_PRIORITY_KEYWORDS = [
    (re.compile(r"\b(?:must|shall|required)\b", re.I), 1),
    (re.compile(r"\b(?:should|recommended)\b", re.I), 3),
    (re.compile(r"\b(?:may|optional)\b", re.I), 5),
]


def infer_priority(text: str) -> int:
    """Grade a rule 1..5 from the RFC 2119 modal keyword in its source phrase (must/shall/required=1,
    should/recommended=3, may/optional=5). Absent any keyword, stay hard (1) — never soften silently.
    First match wins, so a mixed phrase reads as its strongest obligation (the safe default)."""
    for rx, pri in _PRIORITY_KEYWORDS:
        if rx.search(text or ""):
            return pri
    return 1


def _dict_items(value):
    """The dict elements of `value` if it's a list — else []. Shields the merge from a
    small local model returning a non-list `tasks`/`links` or non-dict elements."""
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []


def _clean_duration(value):
    """A positive, finite int duration (clamped), or None. Rejects bool/inf/nan/str/<=0."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return min(int(value), MAX_DURATION_MIN)


# --------------------------------------------------------------------------- #
# The scoped LLM fallback — local Ollama, invoked ONLY on the residual.
# --------------------------------------------------------------------------- #
_SYSTEM = """You read missing scheduling details for a few requirements of an engineering document.

Output ONLY a JSON object: {"tasks": [...]}.

Each requirement is written like "[VR-110] Name". For EACH requirement shown, emit one task:
  {"req_id": "VR-110", "duration_minutes": <int or null>, "resource": "<snake_case owner or shared test resource, or null>"}
Convert any stated effort to minutes: "1 hour"=60, "1 day"=1440, "1 week"=10080. If none is stated, use null.

Use the exact [VR-xxx] ids as written. Report ONLY what the text states — do NOT invent values.
"""


def _ask_json(prompt: str) -> dict:
    """One local-model call returning parsed JSON. Raises on Ollama/parse failure."""
    try:
        msg = ollama.chat(
            model=MODEL,
            messages=[{"role": "system", "content": _SYSTEM},
                      {"role": "user", "content": prompt}],
            format="json",
            options={"temperature": 0, "num_predict": 3072, "num_ctx": 16384, "repeat_penalty": 1.0},
        )
    except Exception as e:  # Ollama down / model not pulled
        raise RuntimeError(
            f"Could not reach local Ollama model '{MODEL}'. Is Ollama running and the model "
            f"pulled (`ollama pull {MODEL}`)? Original error: {e}"
        )
    text = msg.message.content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Be lenient: a small local model sometimes wraps the JSON in prose. Recover the
        # outermost object. (Truncated JSON still fails -> the requirement falls back to default.)
        i, j = text.find("{"), text.rfind("}")
        if 0 <= i < j:
            return json.loads(text[i:j + 1])
        raise


def _residual_batches(reqs: dict, ids: list, max_chars: int = RESIDUAL_MAX_CHARS) -> list[list[str]]:
    """Group residual requirement ids into prompt-sized batches (by body length) so a
    fallback call never silently truncates. Usually one tiny batch — or none."""
    batches, cur, n = [], [], 0
    for rid in ids:
        t = reqs[rid]["text"]
        if cur and n + len(t) > max_chars:
            batches.append(cur)
            cur, n = [], 0
        cur.append(rid)
        n += len(t)
    if cur:
        batches.append(cur)
    return batches


def _run_residual(reqs, residual_ids, ask, progress, warnings):
    """Send ONLY the residual requirements to the local model and harvest what rules missed.

    Returns (llm_fill, llm_calls) where llm_fill[req_id] = {"duration"?: int, "resource"?: str}
    (sanitized). The model fills missing scheduling FIELDS only — it never creates dependency
    edges (those stay 100% deterministic), so the narrow regex's false-edge guard can't be
    reopened through the fallback.
    """
    llm_fill: dict[str, dict] = {}
    calls = 0
    batches = _residual_batches(reqs, residual_ids)
    for bi, batch in enumerate(batches):
        if progress:
            progress(bi, len(batches), f"resolving {len(batch)} residual item(s) with the local model")
        prompt = "\n\n".join(reqs[rid]["text"] for rid in batch)
        try:
            d = ask(prompt)
            calls += 1
        except Exception as e:  # garbled JSON, model hiccup — the items just fall back to defaults
            warnings.append(f"residual model call {bi + 1} failed ({type(e).__name__}); affected items defaulted")
            continue
        if not isinstance(d, dict):
            warnings.append(f"residual model call {bi + 1} returned a non-object; affected items defaulted")
            continue
        batch_ids = set(batch)
        for t in _dict_items(d.get("tasks")):
            rid = str(t.get("req_id") or "").strip().upper()
            if rid not in batch_ids:
                continue  # ignore anything outside the residual we asked about
            entry = llm_fill.setdefault(rid, {})
            dur = _clean_duration(t.get("duration_minutes"))
            if dur is not None:
                entry["duration"] = dur
            if isinstance(t.get("resource"), str) and t["resource"].strip():
                entry["resource"] = t["resource"].strip()
    return llm_fill, calls


def detect_genre(blocks: list[dict]) -> str:
    """Which kind of document is this? "spec" (bracketed [VR-xxx] requirements) or
    "schedule" (day tables with Start/End/Activity columns). A doc with requirement
    definitions is a spec even if it also has tables — the backbone wins."""
    if index_requirements(blocks):
        return "spec"
    if extract_sched.has_schedule_tables(blocks):
        return "schedule"
    return "spec"


# --------------------------------------------------------------------------- #
# Orchestration: deterministic backbone + scoped residual + merge + reconcile.
# --------------------------------------------------------------------------- #
def extract_document(blocks: list[dict], ask=_ask_json, progress=None) -> dict:
    """blocks (from ingest.extract_blocks) -> {scenario, coverage, warnings}.

    Auto-detects the document genre: a requirements SPEC runs the deterministic-first
    backbone below (rules, then a scoped local-model residual); an ops SCHEDULE doc
    (day tables + rule bullets) runs extract_sched — fully deterministic, no model.

    `ask(prompt)->dict` is injectable so the pipeline is testable without Ollama; it is
    invoked ONLY for residual requirements rules could not resolve (often zero calls).
    `progress(i, n, label)` (optional) reports residual-pass progress.
    """
    if detect_genre(blocks) == "schedule":
        if progress:
            progress(1, 1, "schedule genre — deterministic, no model call")
        return extract_sched.extract_schedule(blocks)

    warnings: list[str] = []
    reqs = index_requirements(blocks)            # backbone: every defined [VR-xxx]
    id_set = set(reqs)                            # raw req ids that actually exist
    n = len(reqs)

    # ---- DETERMINISTIC PASS (rules first) ----
    det_fields = det.resolve_activity_fields(reqs)         # duration + resource, with method tags
    det_edges = det.dependency_edges(reqs)                 # (before_raw, after_raw, phrase)
    captured = {(b, a) for (b, a, _s) in det_edges}
    xref = det.cross_reference_audit(reqs, id_set, captured)  # narration vs ambiguous off-format refs
    rationales = {rid: det.parse_rationale(info["text"]) for rid, info in reqs.items()}

    # ---- RESIDUAL SELECTION: only the fields rules left open (a missing duration/resource) ----
    residual_ids = [
        rid for rid in reqs
        if det_fields[rid]["duration_method"] == "missing"
        or det_fields[rid]["resource_method"] == "missing"
    ]

    # ---- SCOPED LLM FALLBACK (the only model calls; often none) ----
    llm_fill, llm_calls = ({}, 0)
    if residual_ids:
        llm_fill, llm_calls = _run_residual(reqs, residual_ids, ask, progress, warnings)
    elif progress:
        progress(1, 1, "resolved deterministically — no model call needed")

    # ---- MERGE: one activity per requirement, with a method tag per field ----
    activities = []
    defaulted = []  # human-facing raw ids whose duration was guessed (coverage compatibility)
    dur_by_method = {"deterministic": [], "llm": [], "default": []}
    res_by_method = {"deterministic": [], "llm": [], "none": []}
    merged_resource = {}  # rid -> the resource that won (rule or llm), for the new constraint types
    for rid, info in reqs.items():
        df = det_fields[rid]
        fill = llm_fill.get(rid, {})

        if df["duration_method"] == "deterministic":
            duration, dmethod = df["duration"], "deterministic"
        elif fill.get("duration"):
            duration, dmethod = fill["duration"], "llm"
        else:
            duration, dmethod = DEFAULT_DURATION_MIN, "default"
            defaulted.append(info["req_id"])

        if df["resource_method"] == "deterministic":
            resource, rmethod = df["resource"], "deterministic"
        elif fill.get("resource"):
            resource, rmethod = fill["resource"], "llm"
        else:
            resource, rmethod = None, "none"
        merged_resource[rid] = resource

        activities.append({
            "id": info["id"],
            "duration": int(duration),
            "label": info["label"][:120],
            "source": info["source"][:400],
            # Adapter -> current IR: the doc's heading breadcrumb is a display GROUP (Activity.type,
            # used for the bar color / Group-by), NOT a resource. A shared physical test resource IS
            # the real contention, so it maps to Activity.section — same section = one-at-a-time in
            # the solver (see solver.py "Sections are one-at-a-time resources").
            "type": info["section"] or None,
            "section": det.snake(resource) if resource else None,
        })
        dur_by_method[dmethod].append(info["req_id"])
        res_by_method[rmethod].append(info["req_id"])

    if defaulted:
        warnings.append(
            f"{len(defaulted)} requirement(s) had no stated duration; defaulted to "
            f"{DEFAULT_DURATION_MIN} min: {', '.join(defaulted)}"
        )

    # ---- DEPENDENCIES: deterministic and authoritative (the local model never creates an edge) ----
    constraints = []
    seen_edges = set()

    def add_precedence(before_raw, after_raw, source):
        if before_raw not in id_set:
            warnings.append(f"dependency references unknown '{before_raw}' — skipped")
            return
        edge = (before_raw, after_raw)
        if edge in seen_edges:
            return
        seen_edges.add(edge)
        if before_raw == after_raw:
            warnings.append(f"{after_raw} depends on itself - kept as a precedence (will be INFEASIBLE)")
        constraints.append({
            "type": "precedence", "before": det.norm_id(before_raw), "after": det.norm_id(after_raw),
            "enabled": True, "label": f"{after_raw} after {before_raw}", "source": source.strip()[:200],
            "priority": infer_priority(source),
            # the WHY comes from the requirement that states the dependency
            "rationale": rationales.get(after_raw, ""),
        })

    for before_raw, after_raw, src in det_edges:
        add_precedence(before_raw, after_raw, src)
    n_precedence = len(constraints)  # every dependency edge is deterministic (deadlines added below)

    # ---- DATES -> project start + deadlines (deterministic) ----
    start_date, horizon_days, deadline_cons, date_warnings = det.derive_dates(blocks, reqs, id_set)
    warnings += date_warnings

    # Adapter -> current IR: derive_dates emits each deadline as a {day, time} Moment (the archive's
    # multi-day shape); today's TimeWindow takes a bare "HH:MM" latest_end + a separate `day` index.
    # Flatten each in place, and grade its priority from the requirement's modal keyword.
    for c in deadline_cons:
        moment = c.pop("latest_end")
        c["latest_end"] = moment["time"]
        c["day"] = moment["day"]
        c["priority"] = infer_priority(c.get("source", ""))
        c["rationale"] = rationales.get(c.pop("req_id", ""), "")
    constraints += deadline_cons

    # ---- STATED operating windows / budgets / overlaps (deterministic) ----
    windows = det.working_windows(reqs)
    kept_windows = []
    for rid, open_t, close_t, phrase in windows:
        if not merged_resource.get(rid):
            # No resource to scope it to. Falling back to "all" would turn one
            # requirement's hours into a plan-wide curfew — skip and say so.
            warnings.append(f"{rid} states operating hours but names no resource — skipped")
            continue
        kept_windows.append(rid)
        constraints.append({
            "type": "working_window",
            "section": det.snake(merged_resource[rid]),
            "open": open_t, "close": close_t, "enabled": True,
            "label": f"{rid} hours {open_t}–{close_t}", "source": phrase[:200],
            "priority": infer_priority(phrase), "rationale": rationales.get(rid, ""),
        })

    budgets = det.section_budgets(reqs)
    kept_budgets = []
    for rid, minutes, phrase in budgets:
        if not merged_resource.get(rid):
            warnings.append(f"{rid} states a total time cap but names no resource — skipped")
            continue
        kept_budgets.append(rid)
        constraints.append({
            "type": "section_budget", "section": det.snake(merged_resource[rid]),
            "max_minutes": minutes, "enabled": True,
            "label": f"{rid} total ≤ {minutes} min", "source": phrase[:200],
            "priority": infer_priority(phrase), "rationale": rationales.get(rid, ""),
        })

    overlaps = det.overlap_edges(reqs)
    kept_overlaps = []
    for rid, ref_raw, mode, phrase in overlaps:
        if ref_raw not in id_set:
            warnings.append(f"{rid} overlaps unknown '{ref_raw}' — skipped")
            continue
        kept_overlaps.append(rid)
        constraints.append({
            # "during [ref]": the referenced activity covers this one
            "type": "overlap", "outer": det.norm_id(ref_raw), "inner": det.norm_id(rid),
            "mode": mode, "enabled": True,
            "label": f"{rid} {'during' if mode == 'contains' else 'concurrent with'} {ref_raw}",
            "source": phrase[:200],
            "priority": infer_priority(phrase), "rationale": rationales.get(rid, ""),
        })

    # Horizon floor: cover the work even if the doc states no dates.
    sum_dur = sum(a["duration"] for a in activities)
    need_days = max(1, (sum_dur // 1440) + 5)
    horizon_days = min(365, max(horizon_days or 0, need_days))

    # Surface deadlines that fall beyond the (possibly 365-day-clamped) horizon.
    beyond = [c for c in deadline_cons if c["day"] > horizon_days]
    if beyond:
        warnings.append(
            f"{len(beyond)} deadline(s) fall beyond the {horizon_days}-day horizon and won't "
            f"bind: " + ", ".join(c["label"] for c in beyond)
        )

    # Adapter -> current IR: the Scenario carries a single `horizon` in MINUTES (there is no
    # start_date / horizon_days field). Convert days->minutes; the derived start_date is display-only,
    # so it rides along in the coverage report rather than the schedule.
    scenario_dict = {
        "activities": activities,
        "constraints": constraints,
        "horizon": horizon_days * 1440,
    }
    # Validate against the IR (the single contract). Constraint ids are auto-filled here.
    scenario = Scenario.model_validate(scenario_dict)

    coverage = _reconcile(blocks, reqs, scenario, defaulted, warnings)
    coverage["extraction"] = _extraction_report(
        dur_by_method, res_by_method, n_precedence, deadline_cons,
        residual_ids, reqs, llm_calls, xref)
    coverage["extraction"]["working_windows"] = len(kept_windows)
    coverage["extraction"]["section_budgets"] = len(kept_budgets)
    coverage["extraction"]["overlaps"] = len(kept_overlaps)
    coverage["extraction"]["rationales"] = sum(1 for r in rationales.values() if r)
    coverage["genre"] = "spec"
    coverage["start_date"] = start_date  # derived project start (display-only; not part of the IR)
    coverage["horizon_days"] = horizon_days  # the day-count behind the minutes horizon (for the UI)

    # A one-line, human-facing summary so the deterministic-first share is visible in the
    # existing "Notes from extraction" panel — no UI change needed to tell the trust story.
    warnings.insert(0, (
        f"Deterministic-first: {len(dur_by_method['deterministic'])}/{n} durations and "
        f"{len(res_by_method['deterministic'])}/{n} resources read by rules; "
        f"{coverage['extraction']['dependencies']['deterministic']} dependencies and "
        f"{len(deadline_cons)} dated deadline(s) resolved deterministically; "
        f"local model used for {len(residual_ids)} residual item(s) in {llm_calls} call(s)."
    ))
    return {"scenario": scenario.model_dump(), "coverage": coverage, "warnings": warnings}


def _extraction_report(dur_by_method, res_by_method, n_precedence, deadline_cons,
                       residual_ids, reqs, llm_calls, xref) -> dict:
    """How each item was resolved — the enrichment that makes the trust story quantifiable."""
    residual_human = [reqs[rid]["req_id"] for rid in residual_ids]
    return {
        "by_method": {k: len(v) for k, v in dur_by_method.items()},  # duration resolution headline
        "duration": dur_by_method,
        "resource": res_by_method,
        "dependencies": {"deterministic": n_precedence, "llm": 0},  # the model never creates an edge
        "dated_deadlines": len(deadline_cons),
        "residual_requirements": residual_human,
        "llm_calls": llm_calls,
        "cross_references": {
            "narrative": [{"requirement": r, "references": ref, "phrase": ph}
                          for (r, ref, ph) in xref["narrative"]],
            "ambiguous": [{"requirement": r, "references": ref, "phrase": ph}
                          for (r, ref, ph) in xref["ambiguous"]],
        },
    }


def _reconcile(blocks, reqs, scenario, defaulted, warnings) -> dict:
    """The trust report: account for EVERY [VR-xxx] in the raw doc, and flag any
    constraint that points at a non-existent activity (silent-drop tripwire)."""
    found_in_doc = sorted({rid for b in blocks for rid in det.find_req_ids(b["text"])})
    activity_ids = {a.id for a in scenario.activities}
    extracted_raw = set(reqs)  # raw ids that became activities

    not_extracted = [rid for rid in found_in_doc if rid not in extracted_raw]
    # A "referenced but never defined" id (e.g. a typo'd cross-reference) is the danger case.
    dangling = []
    for c in scenario.constraints:
        refs = []
        if c.type == "precedence":
            refs = [c.before, c.after]
        elif c.type == "time_window":
            refs = [c.activity]
        elif c.type == "sequence":
            refs = list(c.activities)
        elif c.type == "overlap":
            refs = [c.outer, c.inner]
        elif c.type == "time_lag":
            refs = [c.from_id, c.to_id]
        elif c.type == "min_separation":
            refs = [c.a, c.b]
        for r in refs:
            if r not in activity_ids:
                dangling.append({"constraint": c.id, "missing": r})

    return {
        "requirement_ids_in_doc": found_in_doc,
        "n_in_doc": len(found_in_doc),
        "n_extracted": len(extracted_raw),
        "not_extracted": not_extracted,        # MUST be empty for full coverage
        "defaulted_duration": defaulted,        # extracted, but duration was guessed
        "dangling_references": dangling,        # constraints pointing at missing activities
        "n_activities": len(scenario.activities),
        "n_constraints": len(scenario.constraints),
    }
