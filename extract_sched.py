"""Schedule-genre extraction: ops-schedule blocks -> the RULES + ROSTER, not the pinned timeline.

Some documents aren't requirement specs — they're day-by-day schedules: a few
"Global Constraints" bullets plus one table per day (Start / End / Duration /
Activity / Notes). For those, the right thing to extract is the RULES (the
bullets) and the ROSTER (which activities exist, how long, which days), and
let the solver place them. We deliberately do NOT pin each table row with a
time_window — the printed times are treated as the document's own worked
example, and `check_against_doc` verifies our extracted rules against it (so a
bad rule, or an inconsistency in the document itself, is surfaced, never
silently dropped).

Everything here is deterministic (no LLM): the genre's signal is structural.
Every table row and every bullet ends up in the coverage ledger.
"""
import re

from models import Scenario

DAY = 24 * 60
MAX_DAYS = 366        # a "Day 4000" heading is a broken/hostile doc, not a plan
MAX_BUFFER_PAIRS = 2000  # cap the pairwise "buffer between all activities" fan-out

# A duration token: "8h15m", "2h", "45m", "1h10m". Hours and/or minutes.
_DUR_TOKEN = r"(?:\d+\s*h\s*\d+\s*m|\d+\s*h|\d+\s*m)"
_DUR_PARTS = re.compile(r"(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?", re.I)
_HHMM = re.compile(r"^([0-2]?\d):([0-5]\d)$")

# "Adaptation D1" / "Recovery Day 2" -> a per-day variant of a base activity.
_DAY_VARIANT = re.compile(r"^(.*?)[ _-]+D(?:ay)?\s*(\d+)$", re.I)
# A "Day N" heading names which mission day a table belongs to.
_DAY_HEADING = re.compile(r"\bday\s*(\d+)\b", re.I)

# Genre vocabulary the parsers key on. These are parsing rules (like the
# dependency phrasings in extract_det), not app content.
MEAL_WORDS = {"breakfast", "lunch", "dinner", "supper"}
WAKE_WORDS = {"waking", "wake", "wakeup", "wake_up"}
SOFT_WORDS = re.compile(r"\b(target|goal|prefer(?:red|ably)?|ideally|aim)\b", re.I)
# Time-of-day phrases -> a per-day [open, close) window in minutes. Most
# specific first ("mid-morning" must win over "morning").
TIME_PHRASES = [
    (re.compile(r"first half of (?:the )?day", re.I), (0, 720)),
    (re.compile(r"second half of (?:the )?day", re.I), (720, 1440)),
    (re.compile(r"mid-?morning", re.I), (480, 720)),
    (re.compile(r"\bmorning\b", re.I), (360, 720)),
    (re.compile(r"\bafternoon\b", re.I), (720, 1080)),
    (re.compile(r"\bevening\b", re.I), (1080, 1440)),
]


def dur_to_min(text):
    """'8h15m' / '2h' / '45m' -> minutes, or None if it isn't a duration."""
    if not text:
        return None
    m = _DUR_PARTS.fullmatch(text.strip())
    if not m or (m.group(1) is None and m.group(2) is None):
        return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)


def hhmm_to_min(text):
    """'06:30' -> 390, or None."""
    m = _HHMM.match((text or "").strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def _find_dur(text):
    """The first duration token inside a longer phrase -> minutes, or None."""
    m = re.search(_DUR_TOKEN, text or "", re.I)
    return dur_to_min(m.group(0)) if m else None


def snake(text):
    s = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return s or ""


def _base_key(name):
    """'Adaptation D1' -> 'adaptation'; 'Work C' -> 'work_c'. The roster group key."""
    m = _DAY_VARIANT.match(name or "")
    return snake((m.group(1) if m else name or "").strip())


# --------------------------------------------------------------------------- #
# Day tables -> rows.
# --------------------------------------------------------------------------- #
def _rebuild_tables(blocks):
    """Group the per-cell table blocks back into {table_index: {row: {col: text}}}."""
    tables = {}
    for b in blocks:
        if b.get("kind") == "table" and b.get("table") is not None:
            tables.setdefault(b["table"], {}).setdefault(b["row"], {})[b["col"]] = b["text"]
    return tables


def _header_columns(row0):
    """If row 0 looks like a schedule header, map column name -> index; else None."""
    names = {c: t.strip().lower() for c, t in row0.items()}
    cols = {t: c for c, t in names.items()}
    if {"start", "end", "activity"} <= set(cols):
        return cols
    return None


def _table_day_raw(blocks, t_index):
    """The raw number of the 'Day N' heading above a table, or None if unheaded."""
    for b in blocks:
        if b.get("kind") == "table" and b.get("table") == t_index:
            for crumb in reversed(b.get("section_path", [])):
                m = _DAY_HEADING.search(crumb)
                if m:
                    return int(m.group(1))
            break
    return None


def parse_day_tables(blocks):
    """All schedule-table rows as dicts: {day, start, end, duration, name, notes, source}.

    Returns (rows, n_schedule_tables, n_days). `duration` prefers the Duration
    column and falls back to end-start (with a midnight wrap; a start==end row has
    no readable duration). Header rows are skipped; they're structure, not data.
    Day numbering is normalized to the doc's own base (a "Day 0"-based doc works),
    and an absurd day count is refused rather than built.
    """
    tables = _rebuild_tables(blocks)
    metas = []  # (table_index, header columns, raw 'Day N' number or None)
    for ti in sorted(tables):
        cols = _header_columns(tables[ti].get(0, {}))
        if cols is not None:
            metas.append((ti, cols, _table_day_raw(blocks, ti)))

    # Normalize: subtract the smallest heading number, so Day 0- and Day 1-based
    # docs both map onto 0-based indices; unheaded tables just take the next slot.
    headed = [raw for _ti, _c, raw in metas if raw is not None]
    offset = min(headed) if headed else 0

    rows, days_seen, next_seq = [], set(), 0
    for ti, cols, raw in metas:
        day = (raw - offset) if raw is not None else next_seq
        next_seq = max(next_seq, day + 1)
        days_seen.add(day)
        for ri in sorted(tables[ti]):
            if ri == 0:
                continue
            cells = tables[ti][ri]
            name = (cells.get(cols["activity"], "") or "").strip()
            if not name:
                continue
            start = hhmm_to_min(cells.get(cols["start"], ""))
            end = hhmm_to_min(cells.get(cols["end"], ""))
            duration = dur_to_min(cells.get(cols["duration"], "")) if "duration" in cols else None
            if duration is None and start is not None and end is not None:
                # start == end is a zero-length marker row, not a 24h activity
                duration = ((end - start) % DAY) or None
            notes = (cells.get(cols["notes"], "") or "").strip() if "notes" in cols else ""
            rows.append({
                "day": day, "start": start, "end": end, "duration": duration,
                "name": name, "notes": notes,
                "source": f"Day {day + 1} table: {cells.get(cols['start'], '?')}–"
                          f"{cells.get(cols['end'], '?')} {name}",
            })
    n_days = (max(days_seen) + 1) if days_seen else 0
    if n_days > MAX_DAYS:
        raise ValueError(f"the schedule spans {n_days} days (limit {MAX_DAYS}) — refusing to build it")
    return rows, len(metas), n_days


def has_schedule_tables(blocks):
    """Genre signal: does the doc contain at least one Start/End/Activity table?"""
    tables = _rebuild_tables(blocks)
    return any(_header_columns(t.get(0, {})) for t in tables.values())


# --------------------------------------------------------------------------- #
# Rows -> roster (grouped, recurring vs per-day variants).
# --------------------------------------------------------------------------- #
def build_roster(rows, warnings):
    """Group the table rows into a roster keyed by base activity.

    Each entry: {base, label, ids, instances, per_day: {day: (id, start, end, duration)}}.
    A name with a 'D1' suffix, or one whose duration changes between days, becomes
    per-day variants (id like adaptation_d1, days=[0]); a same-every-day activity
    becomes one recurring id. The actual Activity dicts are built later, in
    finalize_roster, after bullet rules had a chance to set durations.
    """
    groups = {}
    for r in rows:
        m = _DAY_VARIANT.match(r["name"])
        base_label = m.group(1).strip() if m else r["name"]
        key = snake(base_label)
        g = groups.setdefault(key, {"base": key, "label": base_label, "instances": []})
        if m and int(m.group(2)) - 1 != r["day"]:
            warnings.append(f"'{r['name']}' sits in the Day {r['day'] + 1} table — using the table's day")
        if any(i["day"] == r["day"] for i in g["instances"]):
            warnings.append(f"'{r['name']}' appears twice in the Day {r['day'] + 1} table — using the last one")
        g["instances"].append({**r, "variant_label": r["name"]})
    return groups


def finalize_roster(groups, attrs, n_days, warnings):
    """Decide recurring vs per-day for each group and build the Activity dicts.

    `attrs` carries what the bullet rules said: {base: {"duration": min,
    "window": (open, close), "per_day_durations": {day: min}}}. A rule-stated
    duration wins over the table durations (the tables are the worked example,
    the rules are the contract); a mismatch is warned, never hidden.
    """
    activities, roster = [], {}
    for key, g in groups.items():
        a = attrs.get(key, {})
        insts = sorted(g["instances"], key=lambda i: i["day"])
        table_durs = {i["day"]: i["duration"] for i in insts}
        per_day = dict(a.get("per_day_durations", {}))

        # What duration does each day get? rule per-day > rule flat > table.
        rule_flat = a.get("duration")
        durs = {d: per_day.get(d, rule_flat if rule_flat is not None else table_durs[d])
                for d in table_durs}
        stated = {d: v for d, v in {**{d: rule_flat for d in table_durs if rule_flat is not None},
                                    **per_day}.items() if v is not None}
        mism = {d: (table_durs[d], stated[d]) for d in stated
                if d in table_durs and table_durs[d] is not None and table_durs[d] != stated[d]}
        if mism:
            what = ", ".join(f"day {d + 1}: table {t}m vs rule {s}m" for d, (t, s) in sorted(mism.items()))
            warnings.append(f"'{g['label']}' duration differs between the day tables and the stated rule "
                            f"({what}) — the rule wins")

        missing = [d for d, v in durs.items() if v is None]
        if missing:
            warnings.append(f"'{g['label']}' has no readable duration on day(s) "
                            f"{', '.join(str(d + 1) for d in sorted(missing))} — those day(s) skipped")
            durs = {d: v for d, v in durs.items() if v is not None}
            if not durs:
                continue
        days = sorted(durs)
        uniform = len(set(durs.values())) == 1
        window = a.get("window")
        entry = {"base": key, "label": g["label"], "ids": [], "per_day": {}, "days_of": {}}

        def make(act_id, label, duration, act_days):
            act = {"id": act_id, "duration": int(duration), "label": label,
                   "source": insts[0]["source"], "recurs_daily": True,
                   "days": "all" if act_days == list(range(n_days)) else act_days}
            if window:
                act["daily_window"] = {"open": f"{window[0] // 60:02d}:{window[0] % 60:02d}",
                                       "close": f"{window[1] // 60:02d}:{window[1] % 60:02d}"}
            activities.append(act)

        if uniform:
            make(key, g["label"], durs[days[0]], days)
            entry["ids"] = [key]
            entry["days_of"][key] = set(days)
            for i in insts:
                if i["day"] in durs:
                    entry["per_day"][i["day"]] = key
        else:
            # One variant per DAY (a name repeated inside one day keeps the last
            # instance, matching the build_roster warning) — never a duplicate id.
            last_by_day = {i["day"]: i for i in insts}
            for d, i in sorted(last_by_day.items()):
                if d not in durs:
                    continue
                vid = f"{key}_d{d + 1}"
                make(vid, i["variant_label"], durs[d], [d])
                entry["ids"].append(vid)
                entry["per_day"][d] = vid
                entry["days_of"][vid] = {d}
        roster[key] = entry
    return activities, roster


def find_entry(roster, phrase):
    """Match a bullet's subject ('Daily ops sync', 'Adaptation blocks') to a roster entry."""
    p = snake(re.sub(r"^\s*daily\s+", "", (phrase or "").strip(), flags=re.I))
    p = re.sub(r"_blocks?$", "", p)
    if p in roster:
        return roster[p]
    for key, entry in roster.items():
        if key.startswith(p + "_") or p.startswith(key + "_"):
            return entry
    return None


def _meal_entries(roster, rows):
    """The meal roster entries, ordered by when they happen in the tables."""
    med = {}
    for r in rows:
        if r["start"] is not None:
            med.setdefault(snake(r["name"]), []).append(r["start"])
    meals = [e for k, e in roster.items() if k in MEAL_WORDS]
    return sorted(meals, key=lambda e: sorted(med.get(e["base"], [DAY]))[0])


def _sleep_entry(roster):
    return roster.get("sleep")


def _sleep_is_overnight(rows):
    """True when the tables show the sleep block crossing midnight (end < start)."""
    return any(snake(r["name"]) == "sleep" and r["start"] is not None
               and r["end"] is not None and r["end"] < r["start"] for r in rows)


# --------------------------------------------------------------------------- #
# Bullets -> constraint intents + attribute rules.
# --------------------------------------------------------------------------- #
def parse_bullets(bullets, roster, rows, warnings):
    """Read each rule bullet. Returns (intents, attrs, ledger).

    An intent is a symbolic constraint over roster BASE keys — expanded to
    concrete ids later (a base may have per-day variant ids). `attrs` collects
    duration / window rules per base. The ledger records, per bullet, what we
    did with it; an un-modeled bullet is warned and kept visible (never
    silently dropped, never a fabricated constraint).
    """
    intents, attrs, ledger = [], {}, []
    meals = _meal_entries(roster, rows)
    sleep = _sleep_entry(roster)
    wake_shift = 1 if _sleep_is_overnight(rows) else 0

    def attr(base, **kv):
        a = attrs.setdefault(base, {})
        for k, v in kv.items():
            if k == "per_day_durations":
                a.setdefault(k, {}).update(v)
            else:
                a[k] = v

    for text in bullets:
        did = []  # human notes of what this bullet produced
        pri = 3 if SOFT_WORDS.search(text) else 1

        # "Subject: rest" — most rule bullets lead with the activity they govern.
        subject, rest = None, text
        if ":" in text and len(text.split(":", 1)[0]) <= 40:
            subject, rest = (s.strip() for s in text.split(":", 1))
        entry = find_entry(roster, subject) if subject else None

        # A leading duration ("45m immediately before...", "8h15m contiguous",
        # "60m/day", "20m mid-morning") states the subject's duration.
        if entry:
            lead = re.match(rf"\s*({_DUR_TOKEN})\b", rest, re.I)
            if lead:
                attr(entry["base"], duration=dur_to_min(lead.group(1)))
                did.append(f"{entry['base']} duration {dur_to_min(lead.group(1))}m")

        # "Day1=90m, Day2=120m, ..." — per-day durations for the subject.
        per_day = {int(d) - 1: dur_to_min(v)
                   for d, v in re.findall(rf"day\s*(\d+)\s*=\s*({_DUR_TOKEN})", rest, re.I)}
        if entry and per_day:
            attr(entry["base"], per_day_durations=per_day)
            did.append(f"{entry['base']} per-day durations")

        # A time-of-day phrase ("first half of day", "mid-morning") -> daily window.
        if entry:
            for rx, win in TIME_PHRASES:
                if rx.search(text):
                    attr(entry["base"], window=win)
                    did.append(f"{entry['base']} window {win[0] // 60:02d}:00–{win[1] // 60:02d}:00")
                    break

        # "immediately before X" / "immediately after waking" -> zero-gap adjacency.
        m = re.search(r"immediately\s+(before|after)\s+([a-z][a-z \-/]*)", text, re.I)
        if m and entry:
            obj_phrase = m.group(2).strip()
            if snake(obj_phrase) in WAKE_WORDS:
                if sleep:  # waking = the end of the sleep block (next morning if overnight)
                    intents.append({"kind": "time_lag", "from": sleep["base"], "to": entry["base"],
                                    "from_anchor": "end", "to_anchor": "start",
                                    "min_lag": 0, "max_lag": 0, "day_shift": wake_shift,
                                    "label": f"{entry['label']} immediately after waking",
                                    "source": text, "priority": pri})
                    did.append("adjacency after waking")
                else:
                    warnings.append(f"Rule mentions waking but no sleep activity was found: {text}")
            else:
                obj = find_entry(roster, obj_phrase)
                if obj:
                    a, b = (entry, obj) if m.group(1).lower() == "before" else (obj, entry)
                    intents.append({"kind": "time_lag", "from": a["base"], "to": b["base"],
                                    "from_anchor": "end", "to_anchor": "start",
                                    "min_lag": 0, "max_lag": 0, "day_shift": 0,
                                    "label": f"{a['label']} immediately before {b['label']}",
                                    "source": text, "priority": pri})
                    did.append("adjacency")
                else:
                    warnings.append(f"Couldn't match '{obj_phrase}' to a table activity: {text}")

        # "<= 6h between meal starts" -> a start-to-start cap along the day's meals.
        m = re.search(rf"(?:<=|≤)\s*({_DUR_TOKEN})\s+between\s+meal\s+starts", text, re.I)
        if m and len(meals) >= 2:
            cap = dur_to_min(m.group(1))
            for a, b in zip(meals, meals[1:]):
                intents.append({"kind": "time_lag", "from": a["base"], "to": b["base"],
                                "from_anchor": "start", "to_anchor": "start",
                                "min_lag": None, "max_lag": cap, "day_shift": 0,
                                "label": f"{a['label']} → {b['label']} starts ≤ {cap}m apart",
                                "source": text, "priority": pri})
            did.append(f"meal-start chain ≤ {cap}m")

        # ">= 30m away from meals" -> a real buffer between the subject and every meal.
        m = re.search(rf"(?:>=|≥)\s*({_DUR_TOKEN})\s+(?:away\s+)?from\s+(?:any\s+)?meals?", text, re.I)
        if m and entry:
            gap = dur_to_min(m.group(1))
            for meal in meals:
                intents.append({"kind": "min_separation", "a": entry["base"], "b": meal["base"],
                                "gap": gap, "day_shift": 0,
                                "label": f"{entry['label']} ≥ {gap}m from {meal['label']}",
                                "source": text, "priority": pri})
            did.append(f"≥ {gap}m from each meal")

        # "Awake target <=15h45m; absolute max <=16h30m" -> span caps wake -> next sleep.
        if re.search(r"\bawake\b", text, re.I) and sleep:
            m = re.search(rf"target\s*(?:<=|≤)\s*({_DUR_TOKEN})", text, re.I)
            if m:
                intents.append({"kind": "time_lag", "from": sleep["base"], "to": sleep["base"],
                                "from_anchor": "end", "to_anchor": "start",
                                "min_lag": None, "max_lag": dur_to_min(m.group(1)), "day_shift": 1,
                                "label": f"Awake target ≤ {m.group(1)}",
                                "source": text, "priority": 3})
                did.append("awake target (soft)")
            m = re.search(rf"(?:absolute\s+)?max\s*(?:<=|≤)\s*({_DUR_TOKEN})", text, re.I)
            if m:
                intents.append({"kind": "time_lag", "from": sleep["base"], "to": sleep["base"],
                                "from_anchor": "end", "to_anchor": "start",
                                "min_lag": None, "max_lag": dur_to_min(m.group(1)), "day_shift": 1,
                                "label": f"Awake absolute max ≤ {m.group(1)}",
                                "source": text, "priority": 1})
                did.append("awake absolute max (hard)")

        # ">= 10m between activities" -> pairwise buffer. Meals and sleep are excluded:
        # their transitions are governed by their own explicit rules above, and the
        # document's own tables run them back-to-back.
        m = re.search(rf"(?:>=|≥)\s*({_DUR_TOKEN})\s+between\s+(?:all\s+)?activities", text, re.I)
        if m:
            gap = dur_to_min(m.group(1))
            keys = [k for k in roster if k not in MEAL_WORDS and k != "sleep"]
            n_pairs = len(keys) * (len(keys) - 1) // 2
            if n_pairs > MAX_BUFFER_PAIRS:
                # A pairwise rule over hundreds of activities would build an unbounded
                # model inside one request — refuse it visibly instead (warn-but-solve).
                warnings.append(f"Buffer rule spans {len(keys)} activities ({n_pairs} pairs — "
                                f"limit {MAX_BUFFER_PAIRS}); left un-enforced: {text}")
            else:
                for i, a in enumerate(keys):
                    for b in keys[i + 1:]:
                        intents.append({"kind": "min_separation", "a": a, "b": b,
                                        "gap": gap, "day_shift": 0,
                                        "label": f"≥ {gap}m: {roster[a]['label']} ↔ {roster[b]['label']}",
                                        "source": text, "priority": pri})
                did.append(f"pairwise ≥ {gap}m buffer ({len(keys)} activities; meals+sleep excluded — "
                           "their spacing has its own rules)")
                warnings.append(f"Transition buffer applied between all non-meal, non-sleep activities "
                                f"(the tables run meals and sleep back-to-back with their neighbours)")

        # "No overlaps between any activities" -> one no_overlap over everything.
        if re.search(r"\bno\s+overlaps?\b", text, re.I):
            intents.append({"kind": "no_overlap", "label": "No overlaps between any activities",
                            "source": text, "priority": pri})
            did.append("no_overlap all")

        # "3/day" on a meal-ish subject: check the roster actually has that many.
        m = re.search(r"(\d+)\s*/\s*day", text, re.I)
        if m and subject and snake(subject) in ("meals", "meal"):
            want = int(m.group(1))
            if len(meals) != want:
                warnings.append(f"Rule says {want} meals/day but the tables show {len(meals)}")
            m2 = re.search(rf"({_DUR_TOKEN})\s+each", text, re.I)
            if m2:
                for meal in meals:
                    attr(meal["base"], duration=dur_to_min(m2.group(1)))
                did.append(f"each meal {dur_to_min(m2.group(1))}m")

        status = "modeled" if did else "unmodeled"
        if status == "unmodeled":
            warnings.append(f"Un-modeled rule (shown, not enforced): {text}")
        ledger.append({"text": text, "status": status, "effects": did})
    return intents, attrs, ledger


def expand_intents(intents, roster, warnings):
    """Symbolic intents (over base keys) -> concrete constraint dicts (over ids).

    A base that finalized into per-day variants expands into one constraint per
    variant pair — but only pairs that can share a (shifted) day; a Day-1-only
    variant never needs a rule against a Day-2-only one. A base that finalize_roster
    dropped (no readable duration) makes its rules skip, with one warning per base.
    """
    def share_day(a_entry, a_id, b_entry, b_id, shift):
        a_days = a_entry["days_of"].get(a_id, set())
        b_days = b_entry["days_of"].get(b_id, set())
        return any(d + shift in b_days for d in a_days)

    warned_missing = set()

    def entries(*keys):
        found = [roster.get(k) for k in keys]
        for k, e in zip(keys, found):
            if e is None and k not in warned_missing:
                warned_missing.add(k)
                warnings.append(f"rules referencing '{k}' were skipped — it had no readable duration")
        return found if all(found) else None

    cons = []
    for it in intents:
        if it["kind"] == "no_overlap":
            cons.append({"type": "no_overlap", "activities": "all", "enabled": True,
                         "label": it["label"], "source": it["source"], "priority": it["priority"]})
        elif it["kind"] == "time_lag":
            pair = entries(it["from"], it["to"])
            if pair is None:
                continue
            fe, te = pair
            for f in fe["ids"]:
                for t in te["ids"]:
                    if (f == t and it["from"] != it["to"]) \
                            or not share_day(fe, f, te, t, it["day_shift"]):
                        continue
                    cons.append({"type": "time_lag", "from_id": f, "to_id": t,
                                 "from_anchor": it["from_anchor"], "to_anchor": it["to_anchor"],
                                 "min_lag": it["min_lag"], "max_lag": it["max_lag"],
                                 "day_shift": it["day_shift"], "enabled": True,
                                 "label": it["label"], "source": it["source"],
                                 "priority": it["priority"]})
        elif it["kind"] == "min_separation":
            pair = entries(it["a"], it["b"])
            if pair is None:
                continue
            ae, be = pair
            for a in ae["ids"]:
                for b in be["ids"]:
                    if a == b or not share_day(ae, a, be, b, it["day_shift"]):
                        continue
                    cons.append({"type": "min_separation", "a": a, "b": b, "gap": it["gap"],
                                 "day_shift": it["day_shift"], "enabled": True,
                                 "label": it["label"], "source": it["source"],
                                 "priority": it["priority"]})
    return cons


# --------------------------------------------------------------------------- #
# The document self-check: the doc's own timetable vs the extracted rules.
# --------------------------------------------------------------------------- #
def _doc_intervals(rows, roster):
    """The document's printed timetable as {activity_id: {day: (start, end)}} in
    absolute minutes. A row whose end is before its start crosses midnight."""
    occ = {}
    for r in rows:
        if r["start"] is None or r["end"] is None:
            continue
        m = _DAY_VARIANT.match(r["name"])
        key = snake(m.group(1).strip() if m else r["name"])
        entry = roster.get(key)
        if not entry or r["day"] not in entry["per_day"]:
            continue
        aid = entry["per_day"][r["day"]]
        s = r["day"] * DAY + r["start"]
        e = r["day"] * DAY + r["end"]
        if e < s:
            e += DAY  # crosses midnight (start == end stays a zero-length marker)
        occ.setdefault(aid, {})[r["day"]] = (s, e)
    return occ


def check_against_doc(rows, roster, constraints, activities):
    """Verify every extracted constraint against the document's own timetable.

    The day tables are the doc's worked example: if our rules are faithful, that
    example should satisfy them. Each violation is reported (constraint, day,
    what went wrong) — it means either our reading is off or the document
    contradicts itself; both are for the human to see, never to hide.
    Returns {"checked": n, "unchecked": [...], "violations": [...]}.
    """
    occ = _doc_intervals(rows, roster)
    act = {a["id"]: a for a in activities}
    checked, unchecked, violations = 0, [], []

    def pairs(a, b, shift):
        for d, ia in occ.get(a, {}).items():
            ib = occ.get(b, {}).get(d + shift)
            if ib and (a != b or d != d + shift):
                yield d, ia, ib

    for c in constraints:
        cid, ctype = c.get("id", c.get("label", "?")), c["type"]
        if ctype == "time_lag":
            checked += 1
            for d, ia, ib in pairs(c["from_id"], c["to_id"], c.get("day_shift", 0)):
                av = ia[1] if c.get("from_anchor", "end") == "end" else ia[0]
                bv = ib[0] if c.get("to_anchor", "start") == "start" else ib[1]
                lag = bv - av
                lo = c.get("min_lag")
                hi = c.get("max_lag")
                if (lo is not None and lag < lo) or (hi is not None and not lo == hi and lag < 0) \
                        or (hi is not None and lag > hi):
                    violations.append({"constraint": cid, "label": c.get("label", ""), "day": d,
                                       "detail": f"lag {lag}m outside [{lo}, {hi}]"})
        elif ctype == "min_separation":
            checked += 1
            for d, ia, ib in pairs(c["a"], c["b"], c.get("day_shift", 0)):
                gap = c["gap"]
                if not (ib[0] >= ia[1] + gap or ia[0] >= ib[1] + gap):
                    violations.append({"constraint": cid, "label": c.get("label", ""), "day": d,
                                       "detail": f"less than {gap}m apart"})
        elif ctype == "no_overlap":
            checked += 1
            ivs = [(s, e, aid, d) for aid, by_day in occ.items() for d, (s, e) in by_day.items()]
            ivs.sort()
            # Sweep with the furthest end seen so far — a long interval (an overnight
            # sleep) can overlap several later ones, not just its sort neighbour.
            far_end, far_aid, far_day = -1, None, None
            for s, e, aid, d in ivs:
                if s < far_end:
                    violations.append({"constraint": cid, "label": c.get("label", ""), "day": d,
                                       "detail": f"{far_aid} (day {far_day + 1}) overlaps {aid} "
                                                 f"(day {d + 1}) by {far_end - s}m"})
                if e > far_end:
                    far_end, far_aid, far_day = e, aid, d
        else:
            unchecked.append(cid)

    # Windows ride on the activities, not the constraints — check them too.
    for a in activities:
        w = a.get("daily_window")
        if not w:
            continue
        checked += 1
        o, cl = hhmm_to_min(w["open"]), hhmm_to_min(w["close"])
        for d, (s, e) in occ.get(a["id"], {}).items():
            if s < d * DAY + o or e > d * DAY + cl:
                violations.append({"constraint": a["id"], "label": f"{a.get('label', a['id'])} window",
                                   "day": d, "detail": f"outside its {w['open']}–{w['close']} window"})
    return {"checked": checked, "unchecked": unchecked, "violations": violations}


# --------------------------------------------------------------------------- #
# The orchestrator.
# --------------------------------------------------------------------------- #
def extract_schedule(blocks):
    """Schedule-genre blocks -> {scenario, coverage, warnings}. Fully deterministic."""
    warnings = []
    rows, n_tables, n_days = parse_day_tables(blocks)
    if not rows:
        raise ValueError("no schedule-table rows found")

    groups = build_roster(rows, warnings)
    bullets = [b["text"] for b in blocks if b.get("is_bullet")]
    # Two passes over the roster: bullet rules first (they may set durations /
    # windows), then finalize into concrete activities, then expand the rules.
    provisional = {k: {"base": k, "label": g["label"], "ids": [k],
                       "per_day": {i["day"]: k for i in g["instances"]}}
                   for k, g in groups.items()}
    intents, attrs, ledger = parse_bullets(bullets, provisional, rows, warnings)
    activities, roster = finalize_roster(groups, attrs, n_days, warnings)
    constraints = expand_intents(intents, roster, warnings)

    scenario = Scenario.model_validate({
        "activities": activities,
        "constraints": constraints,
        "horizon": max(n_days, 1) * DAY,
    })
    dumped = scenario.model_dump()

    self_check = check_against_doc(rows, roster, dumped["constraints"], dumped["activities"])
    if self_check["violations"]:
        warnings.append(
            f"The document's own timetable breaks {len(self_check['violations'])} of the extracted "
            f"rule check(s) — the doc may contradict itself; see the self-check list.")

    n_modeled = sum(1 for e in ledger if e["status"] == "modeled")
    warnings.insert(0, (
        f"Schedule genre: {len(rows)} table rows over {n_days} day(s) -> {len(activities)} activities; "
        f"{n_modeled}/{len(ledger)} rule bullets modeled as {len(constraints)} constraints; "
        f"doc self-check: {len(self_check['violations'])} violation(s). No model call needed."))

    def row_activity(r):
        # None when the row's group was dropped (no readable duration) — the
        # warning already told the user; the ledger shows it unmatched here.
        entry = roster.get(_base_key(r["name"]))
        return entry["per_day"].get(r["day"]) if entry else None

    coverage = {
        "genre": "schedule",
        "n_tables": n_tables,
        "n_days": n_days,
        "n_rows": len(rows),
        "rows": [{"source": r["source"], "activity": row_activity(r)} for r in rows],
        "bullets": ledger,
        "self_check": self_check,
        "n_activities": len(activities),
        "n_constraints": len(constraints),
        "horizon_days": n_days,
    }
    return {"scenario": dumped, "coverage": coverage, "warnings": warnings}
