"""The LLM-first document READER (deep read) — local Ollama only.

The deterministic pipeline (extract_det/extract) reads FORMATTING: bracketed ids,
"Estimated duration:" labels, verb+[ID] dependency phrases. This module reads MEANING:
the local model sweeps the whole document in overlapping chunks — no headers, ids, or
layout assumed — and reports scheduling facts as typed notes (activities, relations,
recurrence, things it couldn't express). A consolidation pass then resolves those notes
against the deterministic extraction and turns them into IR-shaped PROPOSALS.

Trust design (mirrors the project convention "validate the parsed constraints"):
- The model NEVER writes into the scenario directly. Everything it produces is a
  proposal carrying its evidence quote; the human accepts or rejects each one in the
  review modal before load.
- The deterministic extraction stays authoritative: a relation the rules already
  captured is dropped here, not duplicated.
- Anything the model reports that the IR can't hold (per-cycle recurrence, external
  event anchors) lands in `couldnt_model` — shown, never silently dropped.

Everything is injectable (`ask`) so tests run without Ollama.
"""
import os

import ollama

from parse import MODEL  # the chat model; override via OLLAMA_MODEL
import extract_det as det

# One chunk ~= a few pages of prose. Overlap keeps a relation whose two sentences
# straddle a boundary visible to at least one chunk.
CHUNK_WORDS = int(os.environ.get("DEEP_READ_CHUNK_WORDS", "700"))
OVERLAP_WORDS = int(os.environ.get("DEEP_READ_OVERLAP_WORDS", "120"))
MAX_CHUNKS = int(os.environ.get("DEEP_READ_MAX_CHUNKS", "60"))
# Per model call. Generous by default: the FIRST call also pays the model's cold-start
# (loading 8B weights can alone take minutes on a laptop); the timeout exists to catch a
# wedged model, not a slow one.
TIMEOUT_S = float(os.environ.get("DEEP_READ_TIMEOUT", "600"))

_SYSTEM = """You read ONE chunk of a planning/operations document and report its scheduling facts.

Output ONLY a JSON object: {"activities": [...], "relations": [...], "unmodeled": [...]}

activities — every distinct task/procedure this chunk DEFINES or SCHEDULES (not a mere mention):
  {"name": "<short name as written>", "duration_minutes": <int or null>,
   "resource": "<the owning team/system named for it, or null>",
   "recurrence": "none" | "daily" | "per_cycle" | "other",
   "optionality": "shall" | "should" | "may",
   "evidence": "<copy the exact sentence the fact comes from>"}
Convert stated effort to minutes ("1 hour"=60, "1.5 hours"=90, "1 day"=1440). Null when unstated.
recurrence: "daily" only for every-day wording; "per_cycle" for per cycle/block/window wording.

relations — timing relations the text STATES between two named tasks:
  {"kind": "after" | "before" | "during" | "not_concurrent" | "min_gap",
   "a": "<task name>", "b": "<task name>", "gap_minutes": <int or null>,
   "evidence": "<copy the exact sentence>"}
Meaning: "a after b" = a starts after b ends. "a before b" = a ends before b starts.
"a during b" = a happens inside b. "min_gap" = at least gap_minutes between them.

unmodeled — scheduling statements that do not fit the forms above (triggers, conditions,
external events, capacity rules): {"phrase": "<the sentence>", "reason": "<why it doesn't fit>"}

Rules: report ONLY what the text states — never invent tasks, numbers, or relations.
Copy evidence verbatim. An empty list is a fine answer for a chunk with no scheduling facts.
"""


# --------------------------------------------------------------------------- #
# Chunking — plain text windows over the ingested blocks; no structure assumed.
# --------------------------------------------------------------------------- #
def chunk_blocks(blocks: list[dict], chunk_words: int = CHUNK_WORDS,
                 overlap_words: int = OVERLAP_WORDS) -> list[dict]:
    """[{text, first_block, last_block}] — consecutive blocks joined until the word
    budget fills, then the window slides back by the overlap so boundary-straddling
    facts appear whole in the next chunk."""
    chunks = []
    cur_texts, cur_words, first = [], 0, 0
    i = 0
    while i < len(blocks):
        text = (blocks[i].get("text") or "").strip()
        words = len(text.split())
        if cur_texts and cur_words + words > chunk_words:
            chunks.append({"text": "\n".join(cur_texts), "first_block": first, "last_block": i - 1})
            # Slide back: re-open the window on the trailing blocks that fit the overlap.
            back, back_words = i, 0
            while back > first and back_words < overlap_words:
                back -= 1
                back_words += len((blocks[back].get("text") or "").split())
            first, cur_texts, cur_words = back, [], 0
            for j in range(back, i):
                t = (blocks[j].get("text") or "").strip()
                cur_texts.append(t)
                cur_words += len(t.split())
        if text:
            cur_texts.append(text)
            cur_words += words
        i += 1
    if cur_texts:
        chunks.append({"text": "\n".join(cur_texts), "first_block": first, "last_block": len(blocks) - 1})
    return chunks


# --------------------------------------------------------------------------- #
# The model call — one chunk in, one typed note out.
# --------------------------------------------------------------------------- #
def _ask_notes(prompt: str) -> dict:
    """One local-model call returning parsed JSON notes. Raises RuntimeError with an
    actionable message when Ollama is unreachable; the per-call timeout keeps a wedged
    model from hanging the request forever."""
    import json
    try:
        client = ollama.Client(timeout=TIMEOUT_S)
        msg = client.chat(
            model=MODEL,
            messages=[{"role": "system", "content": _SYSTEM},
                      {"role": "user", "content": prompt}],
            format="json",
            options={"temperature": 0, "num_predict": 3072, "num_ctx": 16384, "repeat_penalty": 1.0},
        )
    except Exception as e:
        raise RuntimeError(
            f"Could not reach local Ollama model '{MODEL}'. Is Ollama running and the model "
            f"pulled (`ollama pull {MODEL}`)? Original error: {e}"
        )
    text = msg.message.content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        i, j = text.find("{"), text.rfind("}")
        if 0 <= i < j:
            return json.loads(text[i:j + 1])
        raise


def read_document(blocks: list[dict], ask=_ask_notes, progress=None) -> dict:
    """Sweep every chunk through the model. Returns {"notes": [note per chunk],
    "chunks": n, "calls": n, "errors": [str]} — a failed chunk is reported, not fatal."""
    chunks = chunk_blocks(blocks)
    dropped = 0
    if len(chunks) > MAX_CHUNKS:
        dropped = len(chunks) - MAX_CHUNKS
        chunks = chunks[:MAX_CHUNKS]
    notes, errors, calls = [], [], 0
    for k, ch in enumerate(chunks):
        if progress:
            progress(k + 1, len(chunks), "reading the document with the local model")
        try:
            note = ask(ch["text"])
            calls += 1
            if isinstance(note, dict):
                notes.append(note)
        except RuntimeError as e:
            # Ollama unreachable: one clear error, stop burning the remaining chunks.
            errors.append(str(e))
            break
        except Exception as e:
            errors.append(f"chunk {k + 1}/{len(chunks)} failed ({type(e).__name__}); skipped")
    if dropped:
        errors.append(f"document larger than the deep-read cap: {dropped} chunk(s) not read")
    return {"notes": notes, "chunks": len(chunks), "calls": calls, "errors": errors}


# --------------------------------------------------------------------------- #
# Consolidation — notes -> IR-shaped proposals, resolved against the extraction.
# --------------------------------------------------------------------------- #
def _norm_tokens(name: str) -> frozenset:
    return frozenset(det.snake(str(name)).split("_")) - {"", "the", "a", "an", "of"}


def _similar(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)

_MATCH_THRESHOLD = 0.6  # token-set Jaccard: "Hazard Detection Sweep" vs "Synthetic Hazard Detection Sweep" matches


def _resolve(name, activities, by_id):
    """A note's task name -> an existing activity id, or None. Match order:
    exact id mention ("[SH-801]" / "sh_801") > exact label > best token overlap."""
    if not name:
        return None
    for rid in det.find_req_ids(str(name)):
        nid = det.norm_id(rid)
        if nid in by_id:
            return nid
    sn = det.snake(str(name))
    if sn in by_id:
        return sn
    tokens = _norm_tokens(name)
    best, best_score = None, 0.0
    for a in activities:
        score = max(_similar(tokens, _norm_tokens(a.get("label") or "")),
                    _similar(tokens, _norm_tokens(a.get("id") or "")))
        if score > best_score:
            best, best_score = a["id"], score
    return best if best_score >= _MATCH_THRESHOLD else None


def _existing_pairs(constraints: list[dict]) -> set:
    """(type-ish, a, b) keys for the constraints the extraction already holds, so a
    model note that restates a captured rule is dropped, not duplicated."""
    pairs = set()
    for c in constraints:
        t = c.get("type")
        if t == "precedence":
            pairs.add(("precedence", c.get("before"), c.get("after")))
        elif t == "overlap":
            pairs.add(("overlap", c.get("outer"), c.get("inner")))
        elif t == "min_separation":
            pairs.add(("min_separation", *sorted((c.get("a") or "", c.get("b") or ""))))
        elif t == "no_overlap" and isinstance(c.get("activities"), list):
            pairs.add(("no_overlap", *sorted(c["activities"])))
    return pairs


def consolidate(read_result: dict, scenario: dict) -> dict:
    """Model notes -> {"activities": [...], "constraints": [...], "couldnt_model": [...],
    "errors": [...]} — every item carries its evidence quote; nothing touches the
    scenario itself. New activities get model-proposed ids (snake of the name)."""
    existing = scenario.get("activities", [])
    by_id = {a["id"]: a for a in existing}
    pairs = _existing_pairs(scenario.get("constraints", []))

    new_acts: dict[str, dict] = {}   # proposed id -> activity proposal
    constraints: list[dict] = []
    couldnt: list[dict] = []
    seen_couldnt = set()

    def add_couldnt(phrase, reason):
        key = (str(phrase)[:120], str(reason)[:80])
        if key not in seen_couldnt:
            seen_couldnt.add(key)
            couldnt.append({"phrase": str(phrase)[:300], "reason": str(reason)[:200]})

    # -- activities: match to the extraction first; only unmatched ones become proposals
    for note in read_result.get("notes", []):
        for t in note.get("activities") or []:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            rec = str(t.get("recurrence") or "none")
            if _resolve(t["name"], existing, by_id):
                # Already extracted deterministically — the model only ADDS what's missing.
                # But a recurrence reading on an existing activity is still worth surfacing.
                if rec == "per_cycle" or rec == "other":
                    add_couldnt(t.get("evidence") or t["name"],
                                "recurrence beyond strict-daily has no IR primitive yet")
                continue
            pid = det.snake(str(t["name"]))[:60]
            if not pid or pid in by_id:
                continue
            dur = t.get("duration_minutes")
            dur = int(dur) if isinstance(dur, (int, float)) and not isinstance(dur, bool) and dur > 0 else None
            prop = {
                "id": pid,
                "duration": dur or 480,
                "label": str(t["name"])[:120],
                "source": str(t.get("evidence") or "")[:400],
                "section": det.snake(str(t["resource"])) if t.get("resource") else None,
                "recurs_daily": rec == "daily",
                "_guessed_duration": dur is None,  # UI hint only; stripped before load
            }
            if rec in ("per_cycle", "other"):
                add_couldnt(t.get("evidence") or t["name"],
                            "recurrence beyond strict-daily has no IR primitive yet")
            new_acts.setdefault(pid, prop)

    all_acts = existing + list(new_acts.values())
    all_ids = set(by_id) | set(new_acts)

    # -- relations: resolve both endpoints, map the kind onto an IR constraint type
    for note in read_result.get("notes", []):
        for r in note.get("relations") or []:
            if not isinstance(r, dict):
                continue
            kind = str(r.get("kind") or "")
            a = _resolve(r.get("a"), all_acts, all_ids)
            b = _resolve(r.get("b"), all_acts, all_ids)
            evidence = str(r.get("evidence") or "")[:400]
            if not a or not b or a == b:
                add_couldnt(evidence or f"{r.get('a')} {kind} {r.get('b')}",
                            "couldn't match both task names to activities")
                continue
            base = {"source": evidence, "priority": 3,
                    "rationale": "Proposed by the local model's deep read; verify against the quoted sentence.",
                    "label": ""}
            if kind in ("after", "before"):
                before, after = (b, a) if kind == "after" else (a, b)
                # Seen live: a small model sometimes swaps the direction. If the EXACT
                # REVERSE of this ordering is already an extracted rule, accepting the
                # proposal would plant a contradiction cycle — surface the disagreement
                # instead, and keep the deterministic reading.
                if ("precedence", after, before) in pairs:
                    add_couldnt(evidence,
                                "the model read the OPPOSITE order of an already-extracted "
                                "rule — kept the deterministic reading")
                    continue
                c = {"type": "precedence", "before": before, "after": after, **base}
                c["label"] = f"{after} after {before} (deep read)"
                key = ("precedence", before, after)
            elif kind == "during":
                c = {"type": "overlap", "outer": b, "inner": a, "mode": "contains", **base}
                c["label"] = f"{a} during {b} (deep read)"
                key = ("overlap", b, a)
            elif kind == "not_concurrent":
                c = {"type": "no_overlap", "activities": [a, b], **base}
                c["label"] = f"{a} and {b} never overlap (deep read)"
                key = ("no_overlap", *sorted((a, b)))
            elif kind == "min_gap":
                gap = r.get("gap_minutes")
                if not isinstance(gap, (int, float)) or isinstance(gap, bool) or gap <= 0:
                    add_couldnt(evidence, "min_gap relation without a positive gap_minutes")
                    continue
                c = {"type": "min_separation", "a": a, "b": b, "gap": int(gap), **base}
                c["label"] = f"≥{int(gap)}m between {a} and {b} (deep read)"
                key = ("min_separation", *sorted((a, b)))
            else:
                add_couldnt(evidence or kind, f"unknown relation kind '{kind}'")
                continue
            if key in pairs:
                continue  # the deterministic extraction already holds this rule
            pairs.add(key)
            constraints.append(c)

        for u in note.get("unmodeled") or []:
            if isinstance(u, dict) and u.get("phrase"):
                add_couldnt(u["phrase"], u.get("reason") or "reported unmodelable by the reader")

    return {
        "activities": list(new_acts.values()),
        "constraints": constraints,
        "couldnt_model": couldnt,
        "errors": read_result.get("errors", []),
        "chunks": read_result.get("chunks", 0),
        "calls": read_result.get("calls", 0),
    }


def deep_read(blocks: list[dict], scenario: dict, ask=_ask_notes, progress=None) -> dict:
    """The whole reader: chunk -> model notes -> consolidated proposals."""
    return consolidate(read_document(blocks, ask=ask, progress=progress), scenario)
