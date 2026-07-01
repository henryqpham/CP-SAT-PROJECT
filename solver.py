"""Turn a validated models.Scenario into a CP-SAT model and solve it."""

from ortools.sat.python import cp_model

from models import Scenario

# Single-day horizon: every time is minutes from midnight, 0..1440 (24h).
DAY = 24 * 60


def _to_minutes(hhmm: str) -> int:
    """'HH:MM' -> minutes from midnight. '10:00' -> 600, '21:00' -> 1260."""
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def solve(scenario: Scenario) -> dict:
    model = cp_model.CpModel()

    # The planning window in minutes. With no horizon set it's one 24h day, so a
    # plain scenario solves exactly as before. A bigger horizon just widens the
    # window the activities can sit in (e.g. 2880 = 2 days); they still pack
    # compactly toward the start.
    horizon = scenario.horizon or DAY

    n_days = max(1, horizon // DAY)

    # Expand recurring activities into one OCCURRENCE per applicable day. A normal activity is a
    # single occurrence free across the whole horizon; a `recurs_daily` activity becomes one
    # occurrence per day, each clamped to its day's window — so "lunch" lands once on EVERY day with
    # no precedence wiring (the per-day spread is structural). Constraints that name a recurring
    # activity by id are skipped (its id isn't a key here; only its per-day occurrences are).
    def _day_bounds(a, d):
        o = _to_minutes(a.daily_window.open) if a.daily_window else 0
        cl = _to_minutes(a.daily_window.close) if a.daily_window else DAY
        return d * DAY + o, min(horizon, d * DAY + cl)

    occurrences = []  # each: {id, src, duration, section, lo, hi}
    for a in scenario.activities:
        if a.recurs_daily:
            for d in range(n_days):
                if a.days != "all" and d not in a.days:
                    continue
                lo, hi = _day_bounds(a, d)
                if hi - lo >= a.duration:  # skip a day whose window can't hold the activity
                    occurrences.append({"id": f"{a.id}#d{d + 1}", "src": a.id,
                                        "duration": a.duration, "section": a.section,
                                        "lo": lo, "hi": hi, "day": d})
        else:
            occurrences.append({"id": a.id, "src": a.id, "duration": a.duration,
                                "section": a.section, "lo": 0, "hi": horizon, "day": None})

    base_duration = {o["id"]: o["duration"] for o in occurrences}

    # Map each activity id to its occurrences (a one-off has one; a recurring activity has one per
    # PLACED day, in day order). Relative-timing constraints resolve their endpoints through this so a
    # rule naming a recurring activity by its bare id no longer silently no-ops (the exact bug that let
    # a rule vanish while the plan still solved OPTIMAL).
    occ_by_src = {}
    for occ in occurrences:
        occ_by_src.setdefault(occ["src"], []).append(occ)

    # Look through the conditionals once to find two things:
    #   - which activities are OPTIONAL (named in a conditional's "when"), and
    #   - which activities change DURATION based on whether another activity
    #     is present (a conditional's "then.set_duration").
    optional_ids = set()
    # duration_rules[activity_id] = {trigger activity, factor, when to apply it}
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
        # Skip rules that don't make sense instead of crashing. The factor must
        # be a number that isn't negative (a negative one would make a negative
        # length), and the rule can't point an activity at itself (that would
        # quietly drop it). A skipped rule just leaves the activity at its
        # normal duration.
        valid_factor = isinstance(factor, (int, float)) and factor >= 0
        if (
            target in base_duration
            and when_activity in base_duration
            and target != when_activity
            and valid_factor
        ):
            # Remember whether the longer duration applies when the trigger is
            # present or when it's absent.
            duration_rules[target] = {
                "trigger": when_activity,
                "factor": factor,
                "apply_when_present": bool(when.get("present", False)),
            }

    starts = {}
    ends = {}
    intervals = {}
    presence = {}  # activity_id -> presence BoolVar (only for optional activities)
    # Each occurrence's contribution to its section's busy-minute total (used by section_budget):
    # a constant for a fixed activity, the size var for a variable-duration one, or base*presence
    # for an optional one (so a dropped activity contributes 0).
    dur_terms = {}

    for occ in occurrences:
        oid = occ["id"]
        lo, hi = occ["lo"], occ["hi"]
        # Each occurrence lives in [lo, hi]: the whole horizon for a normal activity, or just its
        # day's window for a recurring one (which is what keeps day-2's lunch off day 1).
        starts[oid] = model.new_int_var(lo, hi, f"start_{oid}")
        ends[oid] = model.new_int_var(lo, hi, f"end_{oid}")

        is_optional = oid in optional_ids
        rule = duration_rules.get(oid)

        if rule is not None:
            # Variable-size interval: size depends on the trigger's presence.
            base = base_duration[oid]
            scaled = int(base * rule["factor"])  # CP-SAT needs whole numbers, so round to an int
            slo, shi = sorted((base, scaled))
            size = model.new_int_var(slo, shi, f"size_{oid}")

            trigger_present = presence.get(rule["trigger"])
            if trigger_present is None:
                # Trigger's presence var may not exist yet; create it now so we can reference it.
                trigger_present = model.new_bool_var(f"present_{rule['trigger']}")
                presence[rule["trigger"]] = trigger_present

            # Use the scaled length in the branch the rule asked for, the normal length otherwise.
            if rule["apply_when_present"]:
                model.add(size == scaled).only_enforce_if(trigger_present)
                model.add(size == base).only_enforce_if(trigger_present.Not())
            else:
                model.add(size == scaled).only_enforce_if(trigger_present.Not())
                model.add(size == base).only_enforce_if(trigger_present)

            interval = model.new_interval_var(starts[oid], size, ends[oid], f"iv_{oid}")
            dur_terms[oid] = size  # variable duration -> count the actual size var
        elif is_optional:
            present = presence.get(oid)
            if present is None:
                present = model.new_bool_var(f"present_{oid}")
                presence[oid] = present
            interval = model.new_optional_interval_var(
                starts[oid], base_duration[oid], ends[oid], present, f"iv_{oid}"
            )
            dur_terms[oid] = base_duration[oid] * present  # 0 minutes when dropped
        else:
            interval = model.new_interval_var(
                starts[oid], base_duration[oid], ends[oid], f"iv_{oid}"
            )
            dur_terms[oid] = base_duration[oid]  # fixed duration -> a constant

        intervals[oid] = interval

    # Sections are one-at-a-time resources: every OCCURRENCE sharing a (non-empty) section can't
    # overlap any other in that same section.
    sections = {}
    for occ in occurrences:
        if occ["section"]:
            sections.setdefault(occ["section"], []).append(intervals[occ["id"]])
    for ivs in sections.values():
        if len(ivs) >= 2:
            model.add_no_overlap(ivs)

    # What we ask the solver to do, in order of priority: first fit in as many
    # optional activities as possible (a fuller day is the better demo), then
    # neaten the layout. To measure the layout we only want the activities that
    # are actually scheduled, so for a dropped activity we push its start to the
    # end of the day and its end to the start of the day. That way it can't move
    # the earliest start or the latest end we measure below.
    effective_starts, effective_ends = [], []
    for aid in starts:
        p = presence.get(aid)
        if p is None:
            effective_starts.append(starts[aid])
            effective_ends.append(ends[aid])
        else:
            effective_start = model.new_int_var(0, horizon, f"effstart_{aid}")
            effective_end = model.new_int_var(0, horizon, f"effend_{aid}")
            model.add(effective_start == starts[aid]).only_enforce_if(p)
            model.add(effective_start == horizon).only_enforce_if(p.Not())
            model.add(effective_end == ends[aid]).only_enforce_if(p)
            model.add(effective_end == 0).only_enforce_if(p.Not())
            effective_starts.append(effective_start)
            effective_ends.append(effective_end)

    if effective_starts:
        min_start = model.new_int_var(0, horizon, "min_start")
        max_end = model.new_int_var(0, horizon, "max_end")
        model.add_min_equality(min_start, effective_starts)
        model.add_max_equality(max_end, effective_ends)
        # Make the activities sit close together (the block stays compact but can
        # float). With no fixed day start, minimizing the finish instead would
        # drift the activities into the empty early-morning hours.
        tidy = max_end - min_start  # the span of the scheduled block
        # Keeping an activity must always beat any layout gain, so the solver never drops one to
        # tidy up: each kept activity is worth more than the whole span can ever be.
        keep = (2 * horizon + 1) * sum(presence.values()) if presence else 0
        # On a MULTI-DAY plan we DON'T minimize the span: that's exactly what pulls every free task
        # to the front ("everything piles on day 1"), and with recurring occurrences day-clamped it
        # would crush each day toward the centre. Recurrence + working_window do the placing here.
        # The single-day base keeps the compacting term, where a tight block is what you want.
        if n_days > 1:
            if presence:
                model.maximize(keep)
        elif presence:
            model.maximize(keep - tidy)
        else:
            model.minimize(tidy)

    def occ_pairs(a_id, b_id, day_shift=0):
        # Aligned (a_occ_id, b_occ_id) pairs for a relative-timing constraint between two activity
        # ids. A one-off id yields its single key; recurring ids pair by day index (day_shift offsets
        # b's day, so day_shift=1 links a's night-N occurrence to b's day-(N+1) one — the cross-midnight
        # case). A mixed one-off/recurring pair ties the one-off to every occurrence. Unknown or fully
        # dropped ids yield no pairs (the constraint is vacuous).
        a_occs = occ_by_src.get(a_id, [])
        b_occs = occ_by_src.get(b_id, [])
        if not a_occs or not b_occs:
            return []
        a_recurs = a_occs[0]["day"] is not None
        b_recurs = b_occs[0]["day"] is not None
        if a_recurs and b_recurs:
            b_by_day = {o["day"]: o for o in b_occs}
            pairs = []
            for o in a_occs:
                partner = b_by_day.get(o["day"] + day_shift)
                if partner is not None:
                    pairs.append((o["id"], partner["id"]))
            return pairs
        if not a_recurs and not b_recurs:
            return [(a_occs[0]["id"], b_occs[0]["id"])]
        if a_recurs:
            return [(o["id"], b_occs[0]["id"]) for o in a_occs]
        return [(a_occs[0]["id"], o["id"]) for o in b_occs]

    def add_precedence(before, after):
        # `before` ends before `after` starts, paired per day for recurring activities (a bare
        # recurring id used to be silently skipped — a rule that vanished yet the plan still solved).
        for a_oid, b_oid in occ_pairs(before, after):
            model.add(ends[a_oid] <= starts[b_oid])

    for c in scenario.constraints:
        if not c.enabled:
            continue

        if c.type == "time_window":
            # earliest/latest_end are clock times; `day` picks which 0-based mission day they fall on
            # (None = day 0, the day-1-absolute back-compat behavior). The offset shifts the clock onto
            # that day, so "latest_end 18:00, day 2" means "ends by 18:00 on the 3rd day".
            if c.activity not in starts:
                continue
            offset = (c.day or 0) * DAY
            if c.earliest is not None:
                model.add(starts[c.activity] >= offset + _to_minutes(c.earliest))
            if c.latest_end is not None:
                model.add(ends[c.activity] <= offset + _to_minutes(c.latest_end))

        elif c.type == "working_window":
            # A working window's CLOSED complement is forbidden time. Build fixed "closed"
            # intervals per day across the horizon and forbid the governed activities from
            # overlapping them. open/close are a DAILY clock (0..DAY) so the window repeats
            # each day — the per-day mechanism time_window (day-1 absolute) doesn't have.
            o, cl = _to_minutes(c.open), _to_minutes(c.close)
            if o == cl:
                gaps = []                     # open all day -> nothing closed
            elif o < cl:
                gaps = [(0, o), (cl, DAY)]    # same-day: closed before open and after close
            else:
                gaps = [(cl, o)]              # overnight wrap: one closed block between close and open

            target_ivs = [
                intervals[o["id"]] for o in occurrences
                if c.section == "all" or o["section"] == c.section
            ]
            if target_ivs and gaps:
                closed_ivs = []
                for day0 in range(0, horizon, DAY):
                    d = day0 // DAY
                    if c.days != "all" and d not in c.days:
                        continue  # window doesn't apply this day -> day stays fully open
                    for g0, g1 in gaps:
                        s = max(0, day0 + g0)
                        e = min(horizon, day0 + g1)
                        if e > s:
                            closed_ivs.append(
                                model.new_interval_var(s, e - s, e, f"closed_{c.id}_{d}_{g0}")
                            )
                # No governed activity may overlap any closed block. One no_overlap per activity
                # (activity + the shared closed set) forbids straddling for free; it's the exact
                # fixed-interval shape a future "blocker" feature reuses.
                if closed_ivs:
                    for iv in target_ivs:
                        model.add_no_overlap([iv] + closed_ivs)

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
            # Chain of pairwise precedences over adjacent pairs; skip self-pairs.
            for before, after in zip(c.activities, c.activities[1:]):
                if before != after:
                    add_precedence(before, after)

        elif c.type == "overlap":
            # Tie two activities together in time, paired per day for recurring activities. The
            # relation is on the start/end vars, NOT gated by presence: if `inner` is an optional
            # activity that gets dropped, the bound becomes vacuous rather than infeasible (same as
            # precedence on an optional).
            for a_oid, b_oid in occ_pairs(c.outer, c.inner):
                if c.mode == "contains":
                    model.add(starts[a_oid] <= starts[b_oid])  # outer fully covers inner
                    model.add(ends[b_oid] <= ends[a_oid])
                else:  # "overlaps": the two intervals share at least one minute
                    model.add(starts[a_oid] < ends[b_oid])
                    model.add(starts[b_oid] < ends[a_oid])

        elif c.type == "time_lag":
            # A relative-timing bound: lag = (to_anchor of to_id) - (from_anchor of from_id) minutes.
            # Plain model.add on the start/end vars (no presence gating), so a dropped endpoint floats
            # to satisfy the bound — vacuous, never infeasible. Recurring endpoints pair per day.
            for a_oid, b_oid in occ_pairs(c.from_id, c.to_id, c.day_shift):
                a_var = ends[a_oid] if c.from_anchor == "end" else starts[a_oid]
                b_var = starts[b_oid] if c.to_anchor == "start" else ends[b_oid]
                lag = b_var - a_var
                if c.min_lag is not None:
                    model.add(lag >= c.min_lag)
                elif c.max_lag is not None:
                    # A bare max-gap implies "to_id comes after from_id"; without this the solver could
                    # place to_id earlier (a negative lag) and satisfy the cap trivially.
                    model.add(lag >= 0)
                if c.max_lag is not None:
                    model.add(lag <= c.max_lag)

        elif c.type == "min_separation":
            # Keep the pair >= gap apart in EITHER order (a both-directions disjunction; a single
            # inequality would secretly force an order and could make a feasible plan infeasible). Gate
            # both directions on the activities' presence lits so a dropped optional activity makes it
            # vacuous. Recurring activities pair per day.
            for a_oid, b_oid in occ_pairs(c.a, c.b, c.day_shift):
                lits = [p for p in (presence.get(a_oid), presence.get(b_oid)) if p is not None]
                order = model.new_bool_var(f"sep_{c.id}_{a_oid}_{b_oid}")
                model.add(starts[b_oid] >= ends[a_oid] + c.gap).only_enforce_if([order] + lits)
                model.add(starts[a_oid] >= ends[b_oid] + c.gap).only_enforce_if([order.Not()] + lits)

        elif c.type == "section_budget":
            # Total busy minutes in the section must stay within the cap. Sum each member
            # occurrence's duration term (constant / size var / base*presence) and bound it.
            terms = [dur_terms[occ["id"]] for occ in occurrences if occ["section"] == c.section]
            if terms:
                total = sum(terms)
                if isinstance(total, int):
                    # All members are fixed-duration, so the sum is a plain number. If it already
                    # blows the cap, force INFEASIBLE with a self-contradicting var (a plain
                    # `model.add(total <= cap)` here would be a Python bool, which add() rejects).
                    if total > c.max_minutes:
                        over = model.new_bool_var(f"budget_over_{c.id}")
                        model.add(over == 1)
                        model.add(over == 0)
                else:
                    model.add(total <= c.max_minutes)

        # conditional: handled above when building the activity vars.

    solver = cp_model.CpSolver()
    status = solver.solve(model)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        schedule = []
        for occ in occurrences:
            oid = occ["id"]
            # Skip optional occurrences the solver dropped; their start/end are meaningless.
            present_var = presence.get(oid)
            if present_var is not None and not solver.boolean_value(present_var):
                continue
            schedule.append(
                {
                    "id": oid,
                    "start": solver.value(starts[oid]),
                    "end": solver.value(ends[oid]),
                    "source": occ["src"],
                }
            )
        return {"status": "OPTIMAL", "schedule": schedule, "horizon": horizon}

    if status == cp_model.INFEASIBLE:
        return {"status": "INFEASIBLE"}

    return {"status": "UNKNOWN"}


def explain_infeasible(scenario: Scenario) -> dict:
    """For an INFEASIBLE scenario, find a MINIMAL set of enabled constraints that conflict.

    Uses deletion filtering: drop one enabled constraint at a time and re-solve; if the rest is
    still infeasible the dropped rule wasn't essential to the conflict, so leave it out. What
    survives is an irreducible conflict — turning off ANY one of those rules frees the plan. This
    reuses solve() unchanged, so it works for EVERY constraint type (no per-type reification), at
    the cost of O(n) solves. It's called on demand (not in the live solve loop), so that's fine.

    Returns {"structural": bool, "conflict_ids": [...]}:
      - structural=True  -> infeasible even with every rule off (the activities just don't fit the
                            horizon, or a section is over-packed); conflict_ids is empty.
      - conflict_ids     -> the ids of the conflicting constraints (empty if it actually solves now).
    """
    enabled_idx = [i for i, c in enumerate(scenario.constraints) if c.enabled]

    def solve_with(active):
        # Solve a copy where only the constraints whose index is in `active` are enabled.
        trial = scenario.model_copy(deep=True)
        active = set(active)
        for i, c in enumerate(trial.constraints):
            c.enabled = i in active
        return solve(trial)["status"]

    # Not actually infeasible (e.g. the plan changed since) -> nothing to explain.
    if solve_with(enabled_idx) != "INFEASIBLE":
        return {"structural": False, "conflict_ids": []}

    # Still infeasible with every rule off -> the conflict isn't any rule; it's the activities vs.
    # the horizon / section capacity.
    if solve_with([]) == "INFEASIBLE":
        return {"structural": True, "conflict_ids": []}

    keep = list(enabled_idx)
    for i in enabled_idx:
        trial = [j for j in keep if j != i]
        if solve_with(trial) == "INFEASIBLE":
            keep = trial  # i wasn't needed for the conflict; drop it permanently
    return {"structural": False, "conflict_ids": [scenario.constraints[i].id for i in keep]}
