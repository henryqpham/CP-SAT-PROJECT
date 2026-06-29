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
    # plain scenario solves exactly as before (single-day). A bigger horizon lets
    # the solver spread activities across multiple days (e.g. 2880 = 2 days).
    horizon = scenario.horizon or DAY

    base_duration = {a.id: a.duration for a in scenario.activities}

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

    for a in scenario.activities:
        aid = a.id
        # Each activity lives somewhere in the planning window. A per-activity
        # time_window (below) can only tighten this further.
        starts[aid] = model.new_int_var(0, horizon, f"start_{aid}")
        ends[aid] = model.new_int_var(0, horizon, f"end_{aid}")

        is_optional = aid in optional_ids
        rule = duration_rules.get(aid)

        if rule is not None:
            # Variable-size interval: size depends on the trigger's presence.
            base = base_duration[aid]
            scaled = int(base * rule["factor"])  # CP-SAT needs whole numbers, so round to an int
            lo, hi = sorted((base, scaled))
            size = model.new_int_var(lo, hi, f"size_{aid}")

            trigger_present = presence.get(rule["trigger"])
            if trigger_present is None:
                # Trigger's presence var may not exist yet; create it now so we
                # can reference it. (Activities are added in order, but the rule
                # may point forward.)
                trigger_present = model.new_bool_var(f"present_{rule['trigger']}")
                presence[rule["trigger"]] = trigger_present

            # Use the scaled length in the branch the rule asked for, and the
            # normal length in the other branch.
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

    # Sections are one-at-a-time resources: every activity sharing a (non-empty)
    # section can't overlap any other in that same section.
    sections = {}
    for a in scenario.activities:
        if a.section:
            sections.setdefault(a.section, []).append(intervals[a.id])
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
        tidy = max_end - min_start
        if presence:
            # Keeping an activity should always be worth more than any layout
            # improvement, so the solver never drops an activity just to tidy
            # the schedule. We give each kept activity a big reward (bigger than
            # the whole range tidy can span, which is at most the horizon) so
            # keeping always wins.
            model.maximize((2 * horizon + 1) * sum(presence.values()) - tidy)
        else:
            model.minimize(tidy)

    def add_precedence(before, after):
        # `before` ends before `after` starts; skip unless both are real activities.
        if before in ends and after in starts:
            model.add(ends[before] <= starts[after])

    for c in scenario.constraints:
        if not c.enabled:
            continue

        if c.type == "time_window":
            if c.activity not in starts:
                continue
            if c.earliest is not None:
                model.add(starts[c.activity] >= _to_minutes(c.earliest))
            if c.latest_end is not None:
                model.add(ends[c.activity] <= _to_minutes(c.latest_end))

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

        # conditional: handled above when building the activity vars.

    solver = cp_model.CpSolver()
    status = solver.solve(model)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        schedule = []
        for a in scenario.activities:
            aid = a.id
            # Skip optional activities the solver chose to drop; their
            # start/end values are meaningless when absent.
            present_var = presence.get(aid)
            if present_var is not None and not solver.boolean_value(present_var):
                continue
            schedule.append(
                {
                    "id": aid,
                    "start": solver.value(starts[aid]),
                    "end": solver.value(ends[aid]),
                }
            )
        return {"status": "OPTIMAL", "schedule": schedule, "horizon": horizon}

    if status == cp_model.INFEASIBLE:
        return {"status": "INFEASIBLE"}

    return {"status": "UNKNOWN"}
