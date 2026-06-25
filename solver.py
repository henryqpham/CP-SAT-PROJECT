"""Turn a validated models.Scenario into a CP-SAT model and solve it.

Two paths, chosen by an explicit gate (`scenario.is_multi_day`):

- SINGLE-DAY (the original flow): one 0..1440 horizon, minute granularity, the
  optional-day window, and the original lexicographic objective. This path is kept
  byte-for-byte identical to the pre-multi-day code so the existing examples never
  regress — the only forced change is that time_window bounds are now `Moment`
  objects (`.to_minutes()`) instead of bare "HH:MM" strings, which yields the same
  numbers for a day-0 Moment.

- MULTI-DAY (new): an N-day horizon in minutes-from-project-start, solved in
  configurable buckets (SOLVER_BUCKET_MINUTES) to keep interval domains small,
  with a makespan objective, per-`resource` no_overlap, a solver time limit, and
  parallel workers. Returns FEASIBLE distinctly from OPTIMAL.
"""

import math
import os
from collections import defaultdict

from ortools.sat.python import cp_model

from models import Scenario

# Single-day horizon: every time is minutes from midnight, 0..1440 (24h).
DAY = 24 * 60


def _to_minutes(hhmm: str) -> int:
    """'HH:MM' -> minutes from midnight. '10:00' -> 600, '21:00' -> 1260."""
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def _env_int(name: str, default: int, lo: int = 1, hi: int = 10_000_000) -> int:
    """Read a positive integer from the environment, clamped; fall back on garbage."""
    try:
        return max(lo, min(hi, int(os.environ[name])))
    except (KeyError, ValueError):
        return default


def _scan_conditionals(scenario: Scenario, base_duration: dict):
    """Learn the model shape from the conditionals (shared by both solve paths):
      - optional_ids: activities that MAY be dropped (a conditional's when.activity)
      - duration_rules[id] = {trigger, factor, apply_when_present}: an activity whose
        duration scales with another activity's presence (then.set_duration).
    Malformed/nonsensical rules are skipped (left at base duration) rather than
    failing opaquely — same policy as before.
    """
    optional_ids = set()
    duration_rules = {}
    for c in scenario.constraints:
        if not c.enabled or c.type != "conditional":
            continue
        when = c.when or {}
        when_activity = when.get("activity")
        if when_activity in base_duration:
            optional_ids.add(when_activity)
        set_dur = (c.then or {}).get("set_duration") or {}
        target = set_dur.get("activity")
        factor = set_dur.get("factor", 1)
        valid_factor = isinstance(factor, (int, float)) and factor >= 0
        if (
            target in base_duration
            and when_activity in base_duration
            and target != when_activity
            and valid_factor
        ):
            duration_rules[target] = {
                "trigger": when_activity,
                "factor": factor,
                "apply_when_present": bool(when.get("present", False)),
            }
    return optional_ids, duration_rules


def solve(scenario: Scenario) -> dict:
    """Dispatch to the single-day or multi-day model builder by the IR's own gate."""
    if scenario.is_multi_day:
        return _solve_multi_day(scenario)
    return _solve_single_day(scenario)


# --------------------------------------------------------------------------- #
# Single-day path — the original model, unchanged behavior.
# --------------------------------------------------------------------------- #
def _solve_single_day(scenario: Scenario) -> dict:
    model = cp_model.CpModel()

    base_duration = {a.id: a.duration for a in scenario.activities}

    # Optional whole-day window: bounds EVERY activity and anchors the schedule
    # to the start of the day (so "my day runs 8 AM to 10 PM" actually holds).
    day_start, day_end, day_set = 0, DAY, False
    if scenario.day is not None:
        ds, de = _to_minutes(scenario.day.start), _to_minutes(scenario.day.end)
        if 0 <= ds < de <= DAY:
            day_start, day_end, day_set = ds, de, True

    optional_ids, duration_rules = _scan_conditionals(scenario, base_duration)

    starts = {}
    ends = {}
    intervals = {}
    presence = {}  # activity_id -> presence BoolVar (only for optional activities)

    for a in scenario.activities:
        aid = a.id
        # Each activity lives within the day window (full 0..DAY if none set).
        # A per-activity time_window (below) can only tighten this further.
        starts[aid] = model.new_int_var(day_start, day_end, f"start_{aid}")
        ends[aid] = model.new_int_var(day_start, day_end, f"end_{aid}")

        is_optional = aid in optional_ids
        rule = duration_rules.get(aid)

        if rule is not None:
            # Variable-size interval: size depends on the trigger's presence.
            base = base_duration[aid]
            scaled = int(base * rule["factor"])  # int() keeps a float factor's bound integral
            lo, hi = sorted((base, scaled))
            size = model.new_int_var(lo, hi, f"size_{aid}")

            trigger_present = presence.get(rule["trigger"])
            if trigger_present is None:
                trigger_present = model.new_bool_var(f"present_{rule['trigger']}")
                presence[rule["trigger"]] = trigger_present

            if rule["apply_when_present"]:
                model.add(size == scaled).only_enforce_if(trigger_present)
                model.add(size == base).only_enforce_if(trigger_present.Not())
            else:
                model.add(size == scaled).only_enforce_if(trigger_present.Not())
                model.add(size == base).only_enforce_if(trigger_present)

            interval = model.new_interval_var(
                starts[aid], size, ends[aid], f"iv_{aid}"
            )
        elif is_optional:
            present = presence.get(aid)
            if present is None:
                present = model.new_bool_var(f"present_{aid}")
                presence[aid] = present
            interval = model.new_optional_interval_var(
                starts[aid], base_duration[aid], ends[aid], present, f"iv_{aid}"
            )
        else:
            interval = model.new_interval_var(
                starts[aid], base_duration[aid], ends[aid], f"iv_{aid}"
            )

        intervals[aid] = interval

    # Objective (lexicographic): first schedule as many optional activities as
    # possible, then tidy the layout. Absent optionals are neutralized.
    eff_starts, eff_ends = [], []
    for aid in starts:
        p = presence.get(aid)
        if p is None:
            eff_starts.append(starts[aid])
            eff_ends.append(ends[aid])
        else:
            es = model.new_int_var(0, DAY, f"effstart_{aid}")
            ee = model.new_int_var(0, DAY, f"effend_{aid}")
            model.add(es == starts[aid]).only_enforce_if(p)
            model.add(es == DAY).only_enforce_if(p.Not())
            model.add(ee == ends[aid]).only_enforce_if(p)
            model.add(ee == 0).only_enforce_if(p.Not())
            eff_starts.append(es)
            eff_ends.append(ee)

    if eff_starts:
        min_start = model.new_int_var(0, DAY, "min_start")
        max_end = model.new_int_var(0, DAY, "max_end")
        model.add_min_equality(min_start, eff_starts)
        model.add_max_equality(max_end, eff_ends)
        tidy = max_end if day_set else (max_end - min_start)
        if presence:
            model.maximize((2 * DAY + 1) * sum(presence.values()) - tidy)
        else:
            model.minimize(tidy)

    def add_precedence(before, after):
        if before in ends and after in starts:
            model.add(ends[before] <= starts[after])

    for c in scenario.constraints:
        if not c.enabled:
            continue

        if c.type == "time_window":
            if c.activity not in starts:
                continue
            if c.earliest is not None:
                model.add(starts[c.activity] >= c.earliest.to_minutes())
            if c.latest_end is not None:
                model.add(ends[c.activity] <= c.latest_end.to_minutes())

        elif c.type == "no_overlap":
            if c.activities == "all":
                ivs = list(intervals.values())
            else:
                ivs = [intervals[aid] for aid in c.activities if aid in intervals]
            if ivs:
                model.add_no_overlap(ivs)

        elif c.type == "precedence":
            add_precedence(c.before, c.after)

        elif c.type == "sequence":
            for before, after in zip(c.activities, c.activities[1:]):
                if before != after:
                    add_precedence(before, after)

        # conditional: handled above when building the activity vars.

    solver = cp_model.CpSolver()
    status = solver.solve(model)
    return _read_result(scenario, status, solver, starts, ends, presence)


# --------------------------------------------------------------------------- #
# Multi-day path — N-day horizon in buckets, makespan objective, resources.
# --------------------------------------------------------------------------- #
def _solve_multi_day(scenario: Scenario) -> dict:
    model = cp_model.CpModel()
    notes = []

    # Bucket granularity: model in `unit`-minute steps so a multi-week horizon
    # stays a few-thousand-point domain instead of tens of thousands. The IR stays
    # in minutes; we scale in here and scale back out when reading the schedule.
    unit = _env_int("SOLVER_BUCKET_MINUTES", 15)

    base_duration = {a.id: a.duration for a in scenario.activities}

    # --- Horizon (minutes), then converted to units --------------------------
    # Largest absolute time any constraint refers to (deadlines/release dates).
    max_moment = 0
    for c in scenario.constraints:
        if c.type == "time_window":
            for m in (c.earliest, c.latest_end):
                if m is not None:
                    max_moment = max(max_moment, m.to_minutes())
    sum_all = sum(base_duration.values())

    if scenario.horizon_days is not None:
        # User-set horizon is a hard canvas: work that doesn't fit -> INFEASIBLE.
        horizon_min = scenario.horizon_days * DAY
    else:
        # Derived: comfortably cover the work and the latest deadline, then pad.
        need = max(sum_all, max_moment, DAY)
        horizon_min = int(need * 1.5)
    horizon_min = min(horizon_min, 365 * DAY)  # absolute safety cap

    H = max(1, math.ceil(horizon_min / unit))  # horizon in units

    if scenario.day is not None:
        notes.append(
            "Day window ignored in multi-day mode (per-day working hours are not "
            "modeled; tasks float across the full horizon)."
        )

    optional_ids, duration_rules = _scan_conditionals(scenario, base_duration)

    def dur_units(minutes: int) -> int:
        return math.ceil(minutes / unit)  # round work UP — never underestimate

    starts = {}
    ends = {}
    intervals = {}
    presence = {}

    for a in scenario.activities:
        aid = a.id
        starts[aid] = model.new_int_var(0, H, f"start_{aid}")
        ends[aid] = model.new_int_var(0, H, f"end_{aid}")

        is_optional = aid in optional_ids
        rule = duration_rules.get(aid)

        if rule is not None:
            base = dur_units(base_duration[aid])
            scaled = dur_units(int(base_duration[aid] * rule["factor"]))
            lo, hi = sorted((base, scaled))
            size = model.new_int_var(lo, hi, f"size_{aid}")

            trigger_present = presence.get(rule["trigger"])
            if trigger_present is None:
                trigger_present = model.new_bool_var(f"present_{rule['trigger']}")
                presence[rule["trigger"]] = trigger_present

            if rule["apply_when_present"]:
                model.add(size == scaled).only_enforce_if(trigger_present)
                model.add(size == base).only_enforce_if(trigger_present.Not())
            else:
                model.add(size == scaled).only_enforce_if(trigger_present.Not())
                model.add(size == base).only_enforce_if(trigger_present)

            interval = model.new_interval_var(starts[aid], size, ends[aid], f"iv_{aid}")
        elif is_optional:
            present = presence.get(aid)
            if present is None:
                present = model.new_bool_var(f"present_{aid}")
                presence[aid] = present
            interval = model.new_optional_interval_var(
                starts[aid], dur_units(base_duration[aid]), ends[aid], present, f"iv_{aid}"
            )
        else:
            interval = model.new_interval_var(
                starts[aid], dur_units(base_duration[aid]), ends[aid], f"iv_{aid}"
            )

        intervals[aid] = interval

    # Objective: minimize makespan (max end), keeping "schedule as many optional
    # activities as possible" as the dominant term. The presence weight MUST exceed
    # the makespan range [0, H], else the solver would drop optionals to shrink the
    # makespan — so weight = H + 1, tied to the real horizon (NOT to DAY).
    eff_ends = []
    for aid in starts:
        p = presence.get(aid)
        if p is None:
            eff_ends.append(ends[aid])
        else:
            ee = model.new_int_var(0, H, f"effend_{aid}")
            model.add(ee == ends[aid]).only_enforce_if(p)
            model.add(ee == 0).only_enforce_if(p.Not())  # absent -> doesn't inflate makespan
            eff_ends.append(ee)

    if eff_ends:
        makespan = model.new_int_var(0, H, "makespan")
        model.add_max_equality(makespan, eff_ends)
        if presence:
            model.maximize((H + 1) * sum(presence.values()) - makespan)
        else:
            model.minimize(makespan)

    def add_precedence(before, after):
        if before in ends and after in starts:
            model.add(ends[before] <= starts[after])

    # Auto no_overlap per shared resource (a single-capacity resource serializes
    # its activities). More correct and far cheaper at scale than no_overlap("all").
    res_groups = defaultdict(list)
    for a in scenario.activities:
        if a.resource:
            res_groups[a.resource].append(a.id)
    for ids in res_groups.values():
        ivs = [intervals[i] for i in ids if i in intervals]
        if len(ivs) >= 2:
            model.add_no_overlap(ivs)

    for c in scenario.constraints:
        if not c.enabled:
            continue

        if c.type == "time_window":
            if c.activity not in starts:
                continue
            if c.earliest is not None:
                # Round a start lower-bound DOWN and a deadline UP — both loosen, so
                # bucketing never manufactures a false INFEASIBLE.
                model.add(starts[c.activity] >= c.earliest.to_minutes() // unit)
            if c.latest_end is not None:
                model.add(ends[c.activity] <= math.ceil(c.latest_end.to_minutes() / unit))

        elif c.type == "no_overlap":
            if c.activities == "all":
                ivs = list(intervals.values())
            else:
                ivs = [intervals[aid] for aid in c.activities if aid in intervals]
            if ivs:
                model.add_no_overlap(ivs)

        elif c.type == "precedence":
            add_precedence(c.before, c.after)

        elif c.type == "sequence":
            for before, after in zip(c.activities, c.activities[1:]):
                if before != after:
                    add_precedence(before, after)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(_env_int("SOLVER_TIME_LIMIT_SECONDS", 10))
    solver.parameters.num_search_workers = _env_int("SOLVER_WORKERS", 8)
    status = solver.solve(model)

    result = _read_result(scenario, status, solver, starts, ends, presence, scale=unit)
    result["horizon"] = H * unit  # minutes, for the UI axis
    if scenario.start_date:
        result["start_date"] = scenario.start_date
    if notes:
        result["notes"] = notes
    return result


# --------------------------------------------------------------------------- #
# Shared result reader.
# --------------------------------------------------------------------------- #
def _read_result(scenario, status, solver, starts, ends, presence, scale: int = 1) -> dict:
    """Map the solver status to a result dict. `scale` converts solver units back to
    minutes (1 for single-day, the bucket size for multi-day). FEASIBLE is reported
    distinctly from OPTIMAL — both still yield a schedule."""
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        schedule = []
        for a in scenario.activities:
            aid = a.id
            present_var = presence.get(aid)
            if present_var is not None and not solver.boolean_value(present_var):
                continue  # optional activity the solver dropped
            schedule.append(
                {
                    "id": aid,
                    "start": solver.value(starts[aid]) * scale,
                    "end": solver.value(ends[aid]) * scale,
                }
            )
        name = "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE"
        return {"status": name, "schedule": schedule}

    if status == cp_model.INFEASIBLE:
        return {"status": "INFEASIBLE"}

    return {"status": "UNKNOWN"}


# --------------------------------------------------------------------------- #
# Infeasibility explanation — runs ONLY after solve() returns INFEASIBLE.
# --------------------------------------------------------------------------- #
def _build_intervals(model, scenario, lo, hi, unit, optional_ids, duration_rules):
    """start/end/interval/presence vars in `unit`-minute steps, bounded [lo, hi]
    (already in units). Mirrors the solve paths; used only by the explainer."""
    base = {a.id: a.duration for a in scenario.activities}

    def du(m):
        return math.ceil(m / unit)

    starts, ends, intervals, presence = {}, {}, {}, {}
    for a in scenario.activities:
        aid = a.id
        starts[aid] = model.new_int_var(lo, hi, f"s_{aid}")
        ends[aid] = model.new_int_var(lo, hi, f"e_{aid}")
        rule = duration_rules.get(aid)
        if rule is not None:
            b, sc = du(base[aid]), du(int(base[aid] * rule["factor"]))
            l2, h2 = sorted((b, sc))
            size = model.new_int_var(l2, h2, f"sz_{aid}")
            tp = presence.get(rule["trigger"])
            if tp is None:
                tp = model.new_bool_var(f"p_{rule['trigger']}")
                presence[rule["trigger"]] = tp
            if rule["apply_when_present"]:
                model.add(size == sc).only_enforce_if(tp)
                model.add(size == b).only_enforce_if(tp.Not())
            else:
                model.add(size == sc).only_enforce_if(tp.Not())
                model.add(size == b).only_enforce_if(tp)
            intervals[aid] = model.new_interval_var(starts[aid], size, ends[aid], f"iv_{aid}")
        elif aid in optional_ids:
            p = presence.get(aid)
            if p is None:
                p = model.new_bool_var(f"p_{aid}")
                presence[aid] = p
            intervals[aid] = model.new_optional_interval_var(
                starts[aid], du(base[aid]), ends[aid], p, f"iv_{aid}")
        else:
            intervals[aid] = model.new_interval_var(starts[aid], du(base[aid]), ends[aid], f"iv_{aid}")
    return starts, ends, intervals


def _add_overlaps(model, scenario, intervals):
    """no_overlap (all/subset) + auto per-resource no_overlap — these CANNOT be reified,
    so the explainer adds them unconditionally and diagnoses them via relaxation instead."""
    from collections import defaultdict
    for c in scenario.constraints:
        if c.enabled and c.type == "no_overlap":
            ivs = (list(intervals.values()) if c.activities == "all"
                   else [intervals[a] for a in c.activities if a in intervals])
            if ivs:
                model.add_no_overlap(ivs)
    groups = defaultdict(list)
    for a in scenario.activities:
        if a.resource:
            groups[a.resource].append(a.id)
    for ids in groups.values():
        ivs = [intervals[i] for i in ids if i in intervals]
        if len(ivs) >= 2:
            model.add_no_overlap(ivs)


def _apply_scheduling(model, scenario, starts, ends, unit, gate=None, meta=None):
    """Apply time_window/precedence/sequence. If `gate` is given it's called with the
    constraint to obtain a per-constraint assumption literal (for the IIS); otherwise the
    constraints are added unconditionally (for the relaxation probe)."""
    def enforce(expr, c):
        lit = gate(c) if gate is not None else None
        (model.add(expr).only_enforce_if(lit) if lit is not None else model.add(expr))

    for c in scenario.constraints:
        if not c.enabled:
            continue
        if c.type == "time_window" and c.activity in starts:
            if c.earliest is None and c.latest_end is None:
                continue
            lit = gate(c) if gate is not None else None
            if c.earliest is not None:
                e = model.add(starts[c.activity] >= c.earliest.to_minutes() // unit)
                if lit is not None:
                    e.only_enforce_if(lit)
            if c.latest_end is not None:
                e = model.add(ends[c.activity] <= math.ceil(c.latest_end.to_minutes() / unit))
                if lit is not None:
                    e.only_enforce_if(lit)
        elif c.type == "precedence" and c.before in ends and c.after in starts:
            enforce(ends[c.before] <= starts[c.after], c)
        elif c.type == "sequence":
            pairs = [(b, a) for b, a in zip(c.activities, c.activities[1:])
                     if b != a and b in ends and a in starts]
            if not pairs:
                continue
            lit = gate(c) if gate is not None else None
            for b, a in pairs:
                e = model.add(ends[b] <= starts[a])
                if lit is not None:
                    e.only_enforce_if(lit)


def _explain_bounds(scenario, unit):
    """(lo, hi) variable bounds in units, matching the path solve() would take."""
    if scenario.is_multi_day:
        max_moment = 0
        for c in scenario.constraints:
            if c.type == "time_window":
                for m in (c.earliest, c.latest_end):
                    if m is not None:
                        max_moment = max(max_moment, m.to_minutes())
        sum_all = sum(a.duration for a in scenario.activities)
        if scenario.horizon_days is not None:
            horizon_min = scenario.horizon_days * DAY
        else:
            horizon_min = int(max(sum_all, max_moment, DAY) * 1.5)
        horizon_min = min(horizon_min, 365 * DAY)
        return 0, max(1, math.ceil(horizon_min / unit))
    lo, hi = 0, DAY
    if scenario.day is not None:
        ds, de = _to_minutes(scenario.day.start), _to_minutes(scenario.day.end)
        if 0 <= ds < de <= DAY:
            lo, hi = ds, de
    return lo, hi


def explain_infeasibility(scenario: Scenario) -> dict | None:
    """Best-effort explanation of WHY a scenario is INFEASIBLE, as a conflict dict
    {kind, message, constraints:[{id,type,label,source}]} — or None if it can't.

    Logic conflicts (precedence cycles, deadline-vs-dependency, tight windows) are found by
    reifying each gateable rule behind an assumption literal and reading the solver's minimal
    sufficient set. no_overlap is NOT reifiable, so if no gateable subset explains it we probe
    by relaxation (drop overlaps): if that frees the schedule, it's resource over-subscription.
    """
    if not scenario.activities:
        return None
    unit = _env_int("SOLVER_BUCKET_MINUTES", 15) if scenario.is_multi_day else 1
    base_duration = {a.id: a.duration for a in scenario.activities}
    optional_ids, duration_rules = _scan_conditionals(scenario, base_duration)
    lo, hi = _explain_bounds(scenario, unit)

    # ---- pass 1: gated logic IIS ----
    model = cp_model.CpModel()
    starts, ends, intervals = _build_intervals(model, scenario, lo, hi, unit, optional_ids, duration_rules)
    _add_overlaps(model, scenario, intervals)

    lits, meta = [], {}

    def gate(c):
        lit = model.new_bool_var(f"on_{c.id}")
        lits.append(lit)
        meta[lit.index] = {"id": c.id, "type": c.type, "label": c.label, "source": c.source}
        return lit

    _apply_scheduling(model, scenario, starts, ends, unit, gate=gate)

    if lits:
        model.add_assumptions(lits)
        s = cp_model.CpSolver()
        s.parameters.max_time_in_seconds = 5.0
        if s.solve(model) == cp_model.INFEASIBLE:
            seen, cons = set(), []
            for idx in s.sufficient_assumptions_for_infeasibility():
                mt = meta.get(idx)
                if mt and mt["id"] not in seen:
                    seen.add(mt["id"])
                    cons.append(mt)
            if cons:
                labels = ", ".join(c["label"] or c["id"] for c in cons)
                return {"kind": "logic",
                        "message": f"These rules cannot all hold together: {labels}.",
                        "constraints": cons[:8]}

    # ---- pass 2: relaxation probe — drop overlaps; if it frees up, blame resources ----
    overlap_cons = [c for c in scenario.constraints if c.enabled and c.type == "no_overlap"]
    has_resource = any(a.resource for a in scenario.activities)
    if overlap_cons or has_resource:
        m2 = cp_model.CpModel()
        s2, e2, _ = _build_intervals(m2, scenario, lo, hi, unit, optional_ids, duration_rules)
        _apply_scheduling(m2, scenario, s2, e2, unit)  # ungated, NO overlaps added
        solver2 = cp_model.CpSolver()
        solver2.parameters.max_time_in_seconds = 5.0
        if solver2.solve(m2) in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            cons = [{"id": c.id, "type": c.type, "label": c.label, "source": c.source}
                    for c in overlap_cons]
            if has_resource:
                cons.append({"id": "resources", "type": "resource",
                             "label": "Shared-resource contention", "source": ""})
            return {"kind": "resource",
                    "message": "Too much work must run without overlapping (shared resources / "
                               "no-overlap) to fit the available time.",
                    "constraints": cons[:8]}

    return {"kind": "unknown",
            "message": "No schedule satisfies all the rules; the horizon may be too short or a "
                       "window too tight. Try relaxing a deadline or disabling a rule.",
            "constraints": []}
