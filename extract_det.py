"""The deterministic extraction backbone: ingest.py blocks -> activities + constraints, no LLM.

This is the FAST, RELIABLE core of the document path. A controlled requirements
document carries its scheduling signal in structured prose — "[VR-110]" headers,
"Estimated validation effort: 3 days", "Owner: Chassis Team", "depends on [VR-110]",
dated milestones — which rules can read directly and with provenance. Running these
rules FIRST means the local LLM is only ever a scoped fallback for the genuinely
prose-y residue rules can't resolve (see extract.py), which is what collapses a
~5-minute whole-document LLM pass to seconds.

Everything here is a pure function over the block list (or the requirement index),
so it is trivially testable without Ollama and deterministic across runs. Each
resolver reports HOW it resolved a field ("deterministic" / "missing"), so the
coverage report can quantify the deterministic share and never overstate it.

The dependency regex (`_DEP`) and its narration guard are the hardened forms from
the adversarial pass — a narrow allowlist of dependency phrasings plus a negative
lookahead that excludes narrative "after [VR-x] is photographed" clauses. Do NOT
loosen them; doing so reintroduces false precedence edges.
"""
import datetime as _dt
import re

# A requirement DEFINITION header: a bracketed id at the very start, then a name
# (and, unlike a "shall" clause, no "shall"). A bracketed id ANYWHERE is a reference.
_REQ_ID = re.compile(r"\[([A-Z]{2,}-\d+)\]")
_REQ_DEF = re.compile(r"^\s*\[([A-Z]{2,}-\d+)\]\s+(\S.*)$")

# Effort/duration in prose: "3 days", "24 hours", "1 week". Convert to minutes.
_DURATION = re.compile(r"(\d+(?:\.\d+)?)\s*(hour|hr|day|week|month)s?\b", re.I)
_UNIT_MIN = {"hour": 60, "hr": 60, "day": 1440, "week": 10080, "month": 43200}

# Dependency phrasings — a NARROW allowlist (hardened in the adversarial pass). Group 1
# is the high-precision forms; group 2 is a bare "after [ID]" but NOT when [ID] is the
# subject of a clause ("...after [VR-200] is photographed"), which is narration, not a
# prerequisite. Keep the negative lookahead — it is the entire defense against false edges.
_DEP = re.compile(
    r"(?:depends?\s+(?:on|upon)|dependent\s+on|shall\s+not\s+begin\s+until|"
    r"(?:performed|conducted|run|scheduled|started|completed|begin|begun)\s+after|"
    r"runs?\s+after)\s+\[([A-Z]{2,}-\d+)\]"
    r"|"
    r"after\s+\[([A-Z]{2,}-\d+)\](?!\s+(?:is|was|are|were|has|have|had|will|would|can|"
    r"could|becomes?|gets?|occurs?|happens?))",
    re.I,
)
# The mirror image of the negative lookahead: references that ARE narration (deliberately
# NOT dependencies). Used only to CLASSIFY cross-references for the trust log — so a
# narration reference is reported as narration and never offered to the LLM as a
# candidate edge (which would reopen the false-edge bug).
_NARRATIVE_AFTER = re.compile(
    r"after\s+\[([A-Z]{2,}-\d+)\]\s+(?:is|was|are|were|has|have|had|will|would|can|"
    r"could|becomes?|gets?|occurs?|happens?)\b",
    re.I,
)

# Resource phrasings — high-precision, anchored to the deliberate scheduling-signal
# lead-ins ("Requires the [shared] X", "Conducted/Performed on the X", "Owner: X") and
# stopped at a clause boundary. A shared physical test resource (the real contention)
# wins over an owning team. These are intentionally NARROW: the loose "on the …" form
# used to grab narrative shall-text (e.g. "on the control bus and shall log …"), so it
# is gone — a resource we can't read confidently is left for the LLM fallback / review.
_RESOURCE_PATTERNS = [
    re.compile(r"\brequires?\s+the\s+(?:shared\s+)?([A-Za-z][A-Za-z \-]+?)(?=\s+(?:for|to|when|while)\b|[.,;]|$)", re.I),
    re.compile(r"\b(?:conducted|performed|run)\s+on\s+the\s+([A-Za-z][A-Za-z \-]+?)(?=\s+(?:for|to|when|while)\b|[.,;]|$)", re.I),
]
_OWNER = re.compile(r"\bOwner:\s*([A-Za-z][A-Za-z \-]+?)(?=[.,;]|$)", re.I)

# A "Rationale: ..." line inside a requirement body — the human WHY, carried onto
# every constraint derived from that requirement (one line; bodies join with \n).
_RATIONALE = re.compile(r"\bRationale:\s*(.+)", re.I)

# Daily operating hours: "between 08:00 and 17:00" plus an operations word nearby
# (so a lone pair of clock times in prose isn't turned into a window).
_WINDOW = re.compile(
    r"\b(?:between|from)\s+(\d{1,2}:\d{2})\s+(?:and|to|through|–|—|-)\s+(\d{1,2}:\d{2})\b", re.I)
_WINDOW_CONTEXT = re.compile(
    r"\b(?:daily|each day|every day|local time|hours|performed|conducted|testing|"
    r"operations?|available|staffed|occur)\b", re.I)

# A section time budget: needs an aggregate word ("total"/"combined"/"aggregate") so a
# per-activity cap ("effort shall not exceed 3 days") is never misread as a budget.
_BUDGET = re.compile(
    r"\b(?:total|combined|aggregate)\b[^.]*?"
    r"\b(?:shall not exceed|must not exceed|may not exceed|no more than|at most|"
    r"capped at|limited to)\s+(\d+(?:\.\d+)?)\s*(hour|hr|day|week)s?\b", re.I)

# A full HH:MM validity check mirroring the IR's validator, so a malformed clock
# token ("8:75") skips that window instead of failing Scenario validation later.
_HHMM_OK = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$")

# Overlap-in-time with another requirement: "during [VR-x]" -> the referenced one
# covers this one; "concurrent(ly)/in parallel with [VR-x]" -> they just share time.
_OVERLAP = re.compile(
    r"\b(?:(during)|(?:concurrent(?:ly)?|in\s+parallel)\s+with)\s+\[([A-Z]{2,}-\d+)\]", re.I)

# Dates: ISO, "Month DD, YYYY", "DD Month YYYY". Months mapped locally (no dateutil).
_DATE_PATTERNS = [
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), "iso"),
    (re.compile(r"\b([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\b"), "mdy"),
    (re.compile(r"\b(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})\b"), "dmy"),
]
_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], 1)}


# --------------------------------------------------------------------------- #
# Small deterministic helpers (shared with the orchestrator).
# --------------------------------------------------------------------------- #
def norm_id(req_id: str) -> str:
    return req_id.lower().replace("-", "_")


def snake(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s or ""


def find_req_ids(text: str) -> list[str]:
    """Every bracketed [VR-xxx] id in `text` (references and headers alike)."""
    return _REQ_ID.findall(text)


def parse_dates(text: str) -> list[str]:
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


def parse_duration(text: str) -> int | None:
    """Minutes from an explicit effort phrase ("3 days" -> 4320), or None if none stated."""
    m = _DURATION.search(text)
    if not m:
        return None
    return int(round(float(m[1]) * _UNIT_MIN[m[2].lower()]))


def parse_rationale(text: str) -> str:
    """The requirement's 'Rationale: ...' line (first one), or ""."""
    m = _RATIONALE.search(text)
    return m.group(1).strip()[:300] if m else ""


def _sentence(text: str, at: int) -> str:
    """The sentence containing position `at` (bounded by periods/newlines). Keeps a
    phrase's priority grading honest: a neighbouring sentence's 'shall' must not
    override this sentence's 'should'/'may'."""
    lo = max(text.rfind(".", 0, at), text.rfind("\n", 0, at)) + 1
    hi = len(text)
    for stop in (".", "\n"):
        p = text.find(stop, at)
        if p != -1:
            hi = min(hi, p + 1)
    return text[lo:hi].strip()


def _pad_hhmm(t: str) -> str:
    """'8:00' -> '08:00' (the IR wants two-digit hours)."""
    return t.zfill(5)


def working_windows(reqs: dict) -> list[tuple[str, str, str, str]]:
    """Daily operating hours stated in a requirement: (req_id, open, close, phrase).

    Only fires when the clock-time pair sits in a sentence with an operations word
    ("daily", "performed", "testing hours", ...). Overnight (open > close) is allowed —
    the IR wraps it."""
    out = []
    for rid, info in reqs.items():
        for m in _WINDOW.finditer(info["text"]):
            around = _sentence(info["text"], m.start())
            if not _WINDOW_CONTEXT.search(around):
                continue
            o, c = _pad_hhmm(m.group(1)), _pad_hhmm(m.group(2))
            if not _HHMM_OK.match(o) or not _HHMM_OK.match(c):
                continue
            out.append((rid, o, c, around))
            break  # one window per requirement is plenty
    return out


def section_budgets(reqs: dict) -> list[tuple[str, int, str]]:
    """Aggregate time caps: (req_id, max_minutes, phrase). The budgeted section is
    resolved by the caller (the requirement's own resource)."""
    out = []
    for rid, info in reqs.items():
        m = _BUDGET.search(info["text"])
        if m:
            minutes = int(round(float(m.group(1)) * _UNIT_MIN[m.group(2).lower()]))
            out.append((rid, minutes, m.group(0)))
    return out


def overlap_edges(reqs: dict) -> list[tuple[str, str, str, str]]:
    """Stated overlap-in-time: (req_id, referenced_raw_id, mode, phrase).

    "during [VR-x]" -> mode "contains" (the referenced activity covers this one);
    "concurrent with [VR-x]" / "in parallel with [VR-x]" -> mode "overlaps".
    The phrase is the containing sentence, so the caller can grade priority
    from its own modal keyword ("should be conducted during ...")."""
    out = []
    for rid, info in reqs.items():
        for m in _OVERLAP.finditer(info["text"]):
            mode = "contains" if m.group(1) else "overlaps"
            out.append((rid, m.group(2).upper(), mode, _sentence(info["text"], m.start())))
    return out


def parse_resource(text: str) -> str | None:
    """A shared physical test resource (preferred) or owning team, snake-cased — or None.

    Scans the high-precision patterns in order across the requirement body; the first
    confident match wins, with the shared-resource forms taking priority over Owner.
    """
    for rx in _RESOURCE_PATTERNS:
        m = rx.search(text)
        if m and m.group(1).strip():
            return snake(m.group(1))
    ow = _OWNER.search(text)
    if ow and ow.group(1).strip():
        return snake(ow.group(1))
    return None


# --------------------------------------------------------------------------- #
# Requirement index — the spine: every [VR-xxx] definition, in document order.
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
            if req_id in reqs:
                # Duplicate definition: MERGE into the first occurrence (don't discard its
                # body / dependency phrases). Keep the first label/section/id.
                reqs[req_id]["text"] += "\n" + b["text"].strip()
                reqs[req_id]["source"] += " | " + b["text"].strip()
            else:
                reqs[req_id] = {
                    "id": norm_id(req_id),
                    "req_id": req_id,
                    "label": m[2].strip(),
                    "section": " / ".join(b.get("section_path", [])),
                    "source": b["text"].strip(),
                    "text": b["text"].strip(),
                }
        elif b.get("kind") == "heading":
            # A new section heading ENDS the current requirement's body. Without this, a
            # trailing non-requirement section (e.g. "5 Program Milestones") glues onto the
            # last requirement — polluting its source and manufacturing false dependency
            # edges from cross-references that leak in. The body is everything from the
            # definition up to the next heading or next definition.
            current = None
        elif current is not None:
            reqs[current]["text"] += "\n" + b["text"].strip()
            # Keep the first "shall" sentence as the human-facing source line.
            if reqs[current]["source"] == reqs[current]["text"].split("\n")[0] and b.get("is_shall"):
                reqs[current]["source"] += " — " + b["text"].strip()
    return reqs


# --------------------------------------------------------------------------- #
# Agent 1 — deterministic activity fields (duration + resource), with method tags.
# --------------------------------------------------------------------------- #
def resolve_activity_fields(reqs: dict) -> dict:
    """For each requirement, read its duration and resource by rule.

    Returns {req_id: {duration, duration_method, resource, resource_method}} where each
    method is "deterministic" (a rule resolved it) or "missing" (left for the fallback).
    Pure: no defaults are injected here — the orchestrator decides how to fill a gap, so
    the distinction between "rule-resolved" and "guessed" is never lost.
    """
    out = {}
    for rid, info in reqs.items():
        dur = parse_duration(info["text"])
        res = parse_resource(info["text"])
        out[rid] = {
            "duration": dur,
            "duration_method": "deterministic" if dur else "missing",
            "resource": res,
            "resource_method": "deterministic" if res else "missing",
        }
    return out


# --------------------------------------------------------------------------- #
# Agent 2 — deterministic dependencies, cross-reference audit, dated milestones.
# --------------------------------------------------------------------------- #
def dependency_edges(reqs: dict) -> list[tuple[str, str, str]]:
    """Every explicit dependency the narrow regex finds, as (before_raw, after_raw, phrase).

    `after` is the requirement whose body states the dependency; `before` is the
    prerequisite it names. Raw (un-normalized) VR ids; the orchestrator validates and
    normalizes them. Order follows document order then match order.
    """
    edges = []
    for rid, info in reqs.items():
        for m in _DEP.finditer(info["text"]):
            before = (m.group(1) or m.group(2)).upper()
            edges.append((before, rid, m.group(0)))
    return edges


def cross_reference_audit(reqs: dict, id_set: set, captured: set) -> dict:
    """Classify every in-body [VR-x] cross-reference so nothing is silently ignored.

    `captured` is the set of (before_raw, after_raw) edges the deterministic regex already
    produced. For each requirement, each OTHER requirement id it mentions is sorted into:
      - "narrative": matches the narration guard ("after [VR-x] is …") — deliberately NOT a
        dependency; recorded for transparency.
      - "ambiguous": a reference the rules neither captured as an edge nor recognized as
        narration — a possible off-format dependency.
    Both are surfaced in the coverage report for human review and are NEVER turned into edges:
    the deterministic edges are authoritative. A reference already captured as an edge is fully
    resolved and omitted here.
    Returns {"narrative": [(req, ref, phrase)], "ambiguous": [(req, ref, phrase)]}.
    """
    narrative, ambiguous = [], []
    for rid, info in reqs.items():
        text = info["text"]
        narrated = {m.group(1).upper() for m in _NARRATIVE_AFTER.finditer(text)}
        seen = set()
        for m in _REQ_ID.finditer(text):
            ref = m.group(1).upper()
            if ref == rid or ref not in id_set or ref in seen:
                continue
            seen.add(ref)
            if (ref, rid) in captured:
                continue  # already a deterministic edge — resolved
            phrase = _ref_phrase(text, m.start())
            if ref in narrated:
                narrative.append((rid, ref, phrase))
            else:
                ambiguous.append((rid, ref, phrase))
    return {"narrative": narrative, "ambiguous": ambiguous}


def _ref_phrase(text: str, at: int, span: int = 60) -> str:
    """A short window of text around a reference, for human-readable provenance."""
    lo = max(0, at - span)
    hi = min(len(text), at + span)
    return text[lo:hi].replace("\n", " ").strip()


def derive_dates(blocks: list[dict], reqs: dict, id_set: set):
    """Derive a project start_date + horizon from dates in the doc, and turn dated
    milestones tied to a requirement into latest_end deadlines (as multi-day Moments).

    Deterministic: a requirement is tied to a date only when both appear in the SAME block
    ("[VR-1012] … shall be complete by 2026-08-15"). Returns
    (start_date, horizon_days, deadline_constraints, warnings).
    """
    warnings = []
    all_dates = sorted({d for b in blocks for d in parse_dates(b["text"])})
    if not all_dates:
        return None, None, [], warnings
    # The dates in a requirements doc are DEADLINES; the (usually unstated) project start is
    # earlier. Anchor start a lead time before the earliest milestone — sized to the deadline
    # span — so milestones are reachable instead of falling on day 0.
    earliest = _dt.date.fromisoformat(all_dates[0])
    latest = _dt.date.fromisoformat(all_dates[-1])
    lead = max((latest - earliest).days, 30)
    lead = min(lead, (earliest - _dt.date.min).days)  # never underflow date.min (year-1 dates)
    start = earliest - _dt.timedelta(days=lead)
    span_days = (latest - start).days + 7
    warnings.append(
        f"Project start derived as {start.isoformat()} ({lead} days before the earliest "
        f"milestone {earliest.isoformat()}); deadlines are absolute dates from the document."
    )

    cons = []
    pairs = []  # (req_id, iso_date, source)
    for b in blocks:
        ids = _REQ_ID.findall(b["text"])
        dates = parse_dates(b["text"])
        if ids and dates:
            for rid in ids:
                if rid in id_set:
                    pairs.append((rid, dates[0], b["text"]))

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
            "type": "time_window", "activity": norm_id(rid),
            "latest_end": {"day": day, "time": "17:00"},
            "enabled": True, "label": f"{rid} due by {iso}", "source": src.strip()[:200],
            "req_id": rid,  # raw id, so the caller can attach that requirement's rationale
        })
    return start.isoformat(), span_days, cons, warnings
