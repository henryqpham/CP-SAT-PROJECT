"""Map-reduce extraction: a large .docx's structured blocks -> one validated multi-day Scenario.

A 15-page doc far exceeds the local model's usable context, so we DON'T feed it whole.
Pipeline (all local, sequential — privacy + small GPU):

    chunk on section boundaries
      -> per-chunk LOCAL Ollama extraction  (the "map": drafts durations/resources/labels + links)
      -> merge/dedup by requirement id      (the "reduce": one activity per [VR-xxx])
      -> deterministic global pass (regex over the raw blocks for dependencies + dated deadlines)
      -> reconciliation / coverage report   (every [VR-xxx] must be accounted for; dangling refs flagged)

The LLM only DRAFTS the fuzzy bits. The deterministic backbone GUARANTEES the reliability
properties the project is built on: every requirement defined in the doc becomes an activity
with its real source text (no silent drops), and every explicitly-stated dependency survives even
when its two requirements land in different chunks. `extract_document` takes an injectable `ask`
so the whole merge/reconcile pipeline is unit-testable without Ollama.
"""
import datetime as _dt
import json
import re

import ollama

from models import Scenario
from parse import MODEL  # reuse the same local model + OLLAMA_MODEL override

# A requirement DEFINITION header looks like "[VR-110] Antilock Braking Activation":
# a bracketed id at the very start, followed by a name, and (unlike a reference) no "shall".
_REQ_ID = re.compile(r"\[([A-Z]{2,}-\d+)\]")
_REQ_DEF = re.compile(r"^\s*\[([A-Z]{2,}-\d+)\]\s+(\S.*)$")
_DURATION = re.compile(r"(\d+(?:\.\d+)?)\s*(hour|hr|day|week|month)s?\b", re.I)
_UNIT_MIN = {"hour": 60, "hr": 60, "day": 1440, "week": 10080, "month": 43200}
# Dependency phrasings the generator (and real docs) use; each names a prerequisite id.
_DEP = re.compile(
    r"(?:depends on|shall not begin until|begin until|after|following|once)\s*\[([A-Z]{2,}-\d+)\]",
    re.I,
)
_OWNER = re.compile(r"Owner:\s*([^.\n]+)", re.I)
_SHARED = re.compile(r"(?:shared|on the|using the|requires the)\s+([A-Za-z][A-Za-z \-]+?)(?:\.|,| for | to |$)", re.I)
_DATE_PATTERNS = [
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), "iso"),
    (re.compile(r"\b([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\b"), "mdy"),
    (re.compile(r"\b(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})\b"), "dmy"),
]
_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], 1)}

DEFAULT_DURATION_MIN = 480  # 1 working day, when nothing else is stated (flagged in coverage)


# --------------------------------------------------------------------------- #
# Small deterministic helpers.
# --------------------------------------------------------------------------- #
def _norm_id(req_id: str) -> str:
    return req_id.lower().replace("-", "_")


def _snake(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s or ""


def _parse_dates(text: str) -> list[str]:
    """All dates in `text`, as ISO 'YYYY-MM-DD' (calendar-validated). Empty if none."""
    out = []
    for rx, kind in _DATE_PATTERNS:
        for m in rx.finditer(text):
            try:
                if kind == "iso":
                    y, mo, d = int(m[1]), int(m[2]), int(m[3])
                elif kind == "mdy":
                    mo = _MONTHS.get(m[1].lower())
                    y, d = int(m[3]), int(m[2])
                else:  # dmy
                    mo = _MONTHS.get(m[2].lower())
                    y, d = int(m[3]), int(m[1])
                if not mo:
                    continue
                out.append(_dt.date(y, mo, d).isoformat())
            except (ValueError, TypeError):
                continue
    return out


def _parse_duration(text: str) -> int | None:
    m = _DURATION.search(text)
    if not m:
        return None
    return int(round(float(m[1]) * _UNIT_MIN[m[2].lower()]))


def _parse_resource(text: str) -> str | None:
    # A shared physical resource (the real contention) wins over an owning team.
    sh = _SHARED.search(text)
    if sh:
        return _snake(sh[1])
    ow = _OWNER.search(text)
    if ow:
        return _snake(ow[1])
    return None


# --------------------------------------------------------------------------- #
# Requirement index — the deterministic backbone (every [VR-xxx] definition).
# --------------------------------------------------------------------------- #
def index_requirements(blocks: list[dict]) -> dict:
    """Walk blocks in order; group each requirement's body under its definition.

    Returns {req_id: {id, req_id, label, section, source, text}} keyed by the raw VR id,
    in document order (dicts preserve insertion order). `text` is the full body, used for
    regex duration/resource/dependency extraction.
    """
    reqs: dict[str, dict] = {}
    current = None
    for b in blocks:
        m = _REQ_DEF.match(b["text"])
        if m and " shall " not in f" {b['text']} ":
            req_id = m[1]
            current = req_id
            reqs[req_id] = {
                "id": _norm_id(req_id),
                "req_id": req_id,
                "label": m[2].strip(),
                "section": " / ".join(b.get("section_path", [])),
                "source": b["text"].strip(),
                "text": b["text"].strip(),
            }
        elif current is not None:
            reqs[current]["text"] += "\n" + b["text"].strip()
            # Keep the first "shall" sentence as the human-facing source line.
            if reqs[current]["source"] == reqs[current]["text"].split("\n")[0] and b.get("is_shall"):
                reqs[current]["source"] += " — " + b["text"].strip()
    return reqs


# --------------------------------------------------------------------------- #
# Chunking — structural, sized to fit the model with headroom.
# --------------------------------------------------------------------------- #
def chunk_blocks(blocks: list[dict], max_chars: int = 6000) -> list[list[dict]]:
    """Group blocks into chunks at major-section boundaries, never splitting a
    requirement from its body, and capped at ~max_chars so the model never silently
    truncates the tail. (~6000 chars ≈ ~2k tokens input, conservative for granite.)"""
    chunks, cur, cur_len, cur_major = [], [], 0, None
    for b in blocks:
        path = b.get("section_path", [])
        major = path[1] if len(path) > 1 else (path[0] if path else "")
        new_section = major != cur_major and cur
        too_big = cur_len + len(b["text"]) > max_chars and cur and b["kind"] in ("heading", "requirement")
        if new_section or too_big:
            chunks.append(cur)
            cur, cur_len = [], 0
        cur.append(b)
        cur_len += len(b["text"])
        cur_major = major
    if cur:
        chunks.append(cur)
    return chunks


def _chunk_text(chunk: list[dict]) -> str:
    return "\n".join(b["text"] for b in chunk if b["text"].strip())


# --------------------------------------------------------------------------- #
# The "map" step — local Ollama extraction of one chunk into a partial draft.
# --------------------------------------------------------------------------- #
_SYSTEM = """You extract scheduling tasks from one chunk of an engineering requirements document.

Output ONLY a JSON object: {"tasks": [...], "links": [...]}.

Each requirement is written like "[VR-110] Name". For EACH requirement in the chunk, emit one task:
  {"req_id": "VR-110", "label": "<short name>", "duration_minutes": <int>, "resource": "<snake_case owner or shared test resource, or null>"}
Convert any stated effort to minutes: "1 hour"=60, "1 day"=1440, "1 week"=10080. If none stated, use null.

links: ONLY dependencies/deadlines explicitly stated in THIS chunk's text:
  {"type": "precedence", "before": "VR-110", "after": "VR-410", "source": "<the phrase>"}   // before must finish before after starts
  {"type": "deadline", "req_id": "VR-1012", "date": "YYYY-MM-DD", "source": "<the phrase>"}

Use the exact [VR-xxx] ids as written. Map ONLY what the text states — do NOT invent tasks, durations, or links.
"""


def _ask_json(prompt: str) -> dict:
    """One local-model call returning parsed JSON. Raises on Ollama/parse failure."""
    try:
        msg = ollama.chat(
            model=MODEL,
            messages=[{"role": "system", "content": _SYSTEM},
                      {"role": "user", "content": prompt}],
            format="json",
            # num_predict raised vs the single-sentence path: a dense chunk has many tasks.
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
        # outermost object. (Truncated JSON still fails -> the chunk falls back to regex.)
        i, j = text.find("{"), text.rfind("}")
        if 0 <= i < j:
            return json.loads(text[i:j + 1])
        raise


# --------------------------------------------------------------------------- #
# The "reduce" — orchestration: merge drafts + deterministic backbone + reconcile.
# --------------------------------------------------------------------------- #
def extract_document(blocks: list[dict], ask=_ask_json, progress=None) -> dict:
    """blocks (from ingest.extract_blocks) -> {scenario, coverage, warnings}.

    `ask(prompt)->dict` is injectable so the pipeline is testable without Ollama.
    `progress(i, n, label)` (optional) reports per-chunk progress for the slow LLM loop.
    """
    warnings: list[str] = []
    reqs = index_requirements(blocks)            # backbone: every defined [VR-xxx]
    id_set = set(reqs)                            # raw req ids that actually exist

    # ---- map: per-chunk LLM drafts (sequential) ----
    chunks = chunk_blocks(blocks)
    drafts = []  # list of {"tasks":[...], "links":[...]}
    for i, ch in enumerate(chunks):
        if progress:
            path = ch[0].get("section_path", []) if ch else []
            progress(i, len(chunks), path[-1] if path else f"chunk {i + 1}")
        try:
            d = ask(_chunk_text(ch))
            if isinstance(d, dict):
                drafts.append(d)
            else:
                warnings.append(f"chunk {i + 1}: model returned non-object; skipped")
        except Exception as e:  # garbled JSON, model hiccup — keep going (graceful partial)
            warnings.append(f"chunk {i + 1}: extraction failed ({type(e).__name__}); used deterministic fallback")

    # Index the model's task drafts by req id (last non-null value wins on merge).
    llm_tasks: dict[str, dict] = {}
    for d in drafts:
        for t in (d.get("tasks") or []):
            rid = (t.get("req_id") or "").strip().upper()
            if rid in id_set:
                llm_tasks.setdefault(rid, {}).update({k: v for k, v in t.items() if v not in (None, "")})
            elif rid:
                warnings.append(f"model invented task '{rid}' (no such requirement) - ignored")

    # ---- reduce: one activity per requirement, provenance from the doc, enriched by the model ----
    activities = []
    defaulted = []
    for rid, info in reqs.items():
        t = llm_tasks.get(rid, {})
        dur = t.get("duration_minutes")
        if not isinstance(dur, (int, float)) or dur <= 0:
            dur = _parse_duration(info["text"])  # regex fallback
        if not dur or dur <= 0:
            dur = DEFAULT_DURATION_MIN
            defaulted.append(rid)
        resource = t.get("resource") or _parse_resource(info["text"])
        activities.append({
            "id": info["id"],
            "duration": int(dur),
            "label": (t.get("label") or info["label"])[:120],
            "section": info["section"],
            "source": info["source"][:400],
            "resource": _snake(resource) if resource else None,
        })
    if defaulted:
        warnings.append(
            f"{len(defaulted)} requirement(s) had no stated duration; defaulted to "
            f"{DEFAULT_DURATION_MIN} min: {', '.join(defaulted)}"
        )

    # ---- deterministic global dependency pass (regex over each requirement's body) ----
    constraints = []
    seen_edges = set()

    def add_precedence(before_rid, after_rid, source):
        if before_rid not in id_set:
            warnings.append(f"dependency references unknown '{before_rid}' — skipped")
            return
        edge = (before_rid, after_rid)
        if edge in seen_edges:
            return
        seen_edges.add(edge)
        if before_rid == after_rid:
            warnings.append(f"{after_rid} depends on itself - kept as a precedence (will be INFEASIBLE)")
        constraints.append({
            "type": "precedence", "before": _norm_id(before_rid), "after": _norm_id(after_rid),
            "enabled": True, "label": f"{after_rid} after {before_rid}", "source": source.strip()[:200],
        })

    for rid, info in reqs.items():
        for m in _DEP.finditer(info["text"]):
            add_precedence(m[1].upper(), rid, m.group(0))

    # Supplement with model-found precedence links (deduped against the regex edges).
    for d in drafts:
        for ln in (d.get("links") or []):
            if ln.get("type") == "precedence" and ln.get("before") and ln.get("after"):
                b, a = ln["before"].strip().upper(), ln["after"].strip().upper()
                if a in id_set:
                    add_precedence(b, a, ln.get("source", "") or f"{a} depends on {b}")

    # ---- dates -> project start + deadlines ----
    start_date, horizon_days, deadline_cons, date_warnings = _build_dates(blocks, reqs, drafts, id_set)
    warnings += date_warnings
    constraints += deadline_cons

    # Horizon floor: cover the work even if the doc states no dates.
    sum_dur = sum(a["duration"] for a in activities)
    need_days = max(1, (sum_dur // 1440) + 5)
    horizon_days = min(365, max(horizon_days or 0, need_days))

    scenario_dict = {
        "activities": activities,
        "constraints": constraints,
        "start_date": start_date,
        "horizon_days": horizon_days,
    }
    # Validate against the IR (the single contract). Constraint ids are auto-filled here.
    scenario = Scenario.model_validate(scenario_dict)

    coverage = _reconcile(blocks, reqs, scenario, defaulted, warnings)
    return {"scenario": scenario.model_dump(), "coverage": coverage, "warnings": warnings}


def _build_dates(blocks, reqs, drafts, id_set):
    """Derive a project start_date + horizon from dates in the doc, and turn dated
    milestones tied to a requirement into latest_end deadlines (as multi-day Moments)."""
    warnings = []
    all_dates = sorted({d for b in blocks for d in _parse_dates(b["text"])})
    if not all_dates:
        return None, None, [], warnings
    # The dates in a requirements doc are DEADLINES; the (usually unstated) project
    # start is earlier. Anchor start a lead time before the earliest milestone — sized
    # to the deadline span — so milestones are reachable instead of falling on day 0.
    earliest = _dt.date.fromisoformat(all_dates[0])
    latest = _dt.date.fromisoformat(all_dates[-1])
    lead = max((latest - earliest).days, 30)
    start = earliest - _dt.timedelta(days=lead)
    span_days = (latest - start).days + 7
    warnings.append(
        f"Project start derived as {start.isoformat()} ({lead} days before the earliest "
        f"milestone {earliest.isoformat()}); deadlines are absolute dates from the document."
    )

    cons = []
    # Pair a requirement with a date when both appear in the same block ("[VR-1012] ...
    # shall be complete by 2026-08-15"), or from a model 'deadline' link.
    pairs = []  # (req_id, iso_date, source)
    for b in blocks:
        ids = _REQ_ID.findall(b["text"])
        dates = _parse_dates(b["text"])
        if ids and dates:
            for rid in ids:
                if rid in id_set:
                    pairs.append((rid, dates[0], b["text"]))
    for d in drafts:
        for ln in (d.get("links") or []):
            if ln.get("type") == "deadline" and ln.get("req_id", "").upper() in id_set and ln.get("date"):
                try:
                    _dt.date.fromisoformat(ln["date"])
                    pairs.append((ln["req_id"].upper(), ln["date"], ln.get("source", "")))
                except ValueError:
                    pass

    seen = set()
    for rid, iso, src in pairs:
        if (rid, iso) in seen:
            continue
        seen.add((rid, iso))
        day = (_dt.date.fromisoformat(iso) - start).days
        if day < 0:
            warnings.append(f"{rid}: deadline {iso} precedes project start {start} — skipped")
            continue
        cons.append({
            "type": "time_window", "activity": _norm_id(rid),
            "latest_end": {"day": day, "time": "17:00"},
            "enabled": True, "label": f"{rid} due by {iso}", "source": src.strip()[:200],
        })
    return start.isoformat(), span_days, cons, warnings


def _reconcile(blocks, reqs, scenario, defaulted, warnings) -> dict:
    """The trust report: account for EVERY [VR-xxx] in the raw doc, and flag any
    constraint that points at a non-existent activity (silent-drop tripwire)."""
    found_in_doc = sorted({rid for b in blocks for rid in _REQ_ID.findall(b["text"])})
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
