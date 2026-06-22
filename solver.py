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

    base_duration = {a.id: a.duration for a in scenario.activities}

    # Optional whole-day window: bounds EVERY activity and anchors the schedule
    # to the start of the day (so "my day runs 8 AM to 10 PM" actually holds).
    day_start, day_end, day_set = 0, DAY, False
    if scenario.day is not None:
        ds, de = _to_minutes(scenario.day.start), _to_minutes(scenario.day.end)
        if 0 <= ds < de <= DAY:
            day_start, day_end, day_set = ds, de, True

    # Scan conditionals once to learn the model shape:
    #   - which activity is OPTIONAL (a conditional's when.activity), and
    #   - which activity has a CONDITIONAL DURATION (then.set_duration), keyed
    #     on the optional activity's presence.
    optional_ids = set()
    # duration_rules[activity_id] = (presence_literal_owner_id, factor)
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
        # Ignore malformed/nonsensical rules rather than failing opaquely: a
        # negative or non-numeric factor would build a negative interval size,
        # and a self-referential rule ("if X is absent, change X's duration")
        # would silently drop X. Skipping leaves the activity at base duration.
        valid_factor = isinstance(factor, (int, float)) and factor >= 0
        if (
            target in base_duration
            and when_activity in base_duration
            and target != when_activity
            and valid_factor
        ):
            # Honor the present flag: factor applies in the branch named by it.
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
                # Trigger's presence var may not exist yet; create it now so we
                # can reference it. (Activities are added in order, but the rule
                # may point forward.)
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
    # possible (a fuller day is the better demo), then tidy the layout. We work
    # over the *present* activities; absent optionals are neutralized so they
    # don't count (start->DAY, end->0 raise/widen nothing).
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
        # With a day window, minimize the finish time so the schedule packs from
        # the start of the day. Without one, minimize only the span (width): the
        # block stays compact but its position floats (minimizing the finish with
        # no day floor would just drift activities into the empty pre-dawn hours).
        tidy = max_end if day_set else (max_end - min_start)
        if presence:
            # Presence dominates: one more activity beats any layout saving.
            model.maximize((DAY + 1) * sum(presence.values()) - tidy)
        else:
            model.minimize(tidy)

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
            if c.before in ends and c.after in starts:
                model.add(ends[c.before] <= starts[c.after])

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
        return {"status": "OPTIMAL", "schedule": schedule}

    if status == cp_model.INFEASIBLE:
        return {"status": "INFEASIBLE"}

    return {"status": "UNKNOWN"}
