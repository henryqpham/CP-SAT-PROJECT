# Pydantic models for the intermediate representation (IR).
# The LLM produces this; the user edits it; solver.py turns it into CP-SAT.
import re
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator

# "HH:MM" with HH 00..24 and MM 00..59; "24:00" is the allowed end-of-day
# sentinel, so accept hour 24 but reject anything past it (e.g. "24:30").
_HHMM = re.compile(r"^([01]\d|2[0-4]):([0-5]\d)$")


def _validate_hhmm(v: Optional[str]) -> Optional[str]:
    # Shared by every "HH:MM" field; None (when allowed) passes through.
    if v is None:
        return v
    if not _HHMM.match(v) or v > "24:00":
        raise ValueError(f"expected HH:MM time (00:00–24:00), got {v!r}")
    return v


class DailyWindow(BaseModel):
    # A per-day [open, close] clock (relative to each day's start) for a recurring activity's
    # occurrences. Same-day only — for an overnight rhythm, use a section + working_window instead.
    open: str = "00:00"
    close: str = "24:00"

    _check_times = field_validator("open", "close")(_validate_hhmm)

    @model_validator(mode="after")
    def _check_order(self):
        # Zero-padded "HH:MM" compares lexically the same as by time, so this is a real ordering
        # check. Reject overnight (open >= close) loudly instead of silently dropping every
        # occurrence (an inverted window can never hold the activity, so it'd just vanish).
        if self.open >= self.close:
            raise ValueError("daily_window open must be before close (same-day window only)")
        return self


class Activity(BaseModel):
    id: str
    duration: int  # minutes
    # Provenance + display, carried end-to-end so a human can verify each item against the source
    # document (filled by the doc-ingest path; empty for hand-built plans). The solver ignores both.
    label: str = ""    # human-readable name (id is snake_case)
    source: str = ""   # the exact requirement text/phrase this activity came from
    section: Optional[str] = None  # free-text group; same section = one at a time
    # Free-text owner/group label (a worker, a friend, a crew member…). DISPLAY-ONLY: the solver
    # ignores it; the dashboard can group the timeline swimlanes by it. You fill it in per activity.
    assignee: Optional[str] = None
    # Activity category/type (e.g. "Prep", "Cleaning"). DISPLAY-ONLY like assignee: the solver ignores
    # it; the dashboard uses it for the bar color and as a Group-by option. Set from the Library or Inspector.
    type: Optional[str] = None
    # Recurrence: when true the solver EXPANDS this into one occurrence per day across the horizon,
    # each clamped to its day (and to `daily_window` if set), so e.g. "lunch" lands once on every
    # mission day with no precedence wiring. `days` limits which 0-based days it recurs on.
    recurs_daily: bool = False
    daily_window: Optional[DailyWindow] = None
    days: Union[Literal["all"], list[int]] = "all"

    @field_validator("days")
    @classmethod
    def _check_days(cls, v):
        if v == "all":
            return v
        if not v or any(d < 0 for d in v):
            raise ValueError("days must be 'all' or a list of non-negative day indices")
        return v


class _Constraint(BaseModel):
    # Fields every constraint shares; each variant below adds its own `type` + data.
    id: str = ""  # auto-filled (c1, c2, …) by Scenario if the LLM omits it
    enabled: bool = True
    label: str = ""
    source: str = ""    # verbatim provenance: the exact phrase this rule came from (never fabricated)
    # Priority: 1 = hardest ("physical"/inviolable) … 5 = casual preference (dropped first). Default 1
    # keeps every existing plan as-hard as today. It does NOT change the live solve (all rules stay
    # hard there); it only tells the on-demand priority-ordered relaxation which rules it MAY drop
    # (never a priority-1 rule) to make an infeasible plan fit. `rationale` is the human WHY.
    priority: int = 1
    rationale: str = ""

    @field_validator("priority")
    @classmethod
    def _check_priority(cls, v):
        if v < 1 or v > 5:
            raise ValueError("priority must be 1..5 (1 = hard/inviolable, 5 = casual preference)")
        return v


class TimeWindow(_Constraint):
    type: Literal["time_window"] = "time_window"
    activity: str
    earliest: Optional[str] = None    # "HH:MM"
    latest_end: Optional[str] = None  # "HH:MM"
    # Which 0-based mission day the clock applies to. None = day 0 (back-compat). day=2 means the
    # earliest/latest_end are clock times on the 3rd day, e.g. "undock by 18:00 on day 3".
    day: Optional[int] = None

    _check_times = field_validator("earliest", "latest_end")(_validate_hhmm)

    @field_validator("day")
    @classmethod
    def _check_day(cls, v):
        if v is not None and v < 0:
            raise ValueError("day must be a non-negative day index")
        return v


class NoOverlap(_Constraint):
    type: Literal["no_overlap"] = "no_overlap"
    activities: Union[Literal["all"], list[str]] = "all"


class Precedence(_Constraint):
    type: Literal["precedence"] = "precedence"
    before: str  # this activity ends before...
    after: str   # ...this one starts


class Sequence(_Constraint):
    type: Literal["sequence"] = "sequence"
    activities: list[str]  # ordered; each one ends before the next begins


class Conditional(_Constraint):
    type: Literal["conditional"] = "conditional"
    when: dict   # e.g. {"activity": "kiteboard", "present": false}
    then: dict   # e.g. {"set_duration": {"activity": "sail", "factor": 2}}


class WorkingWindow(_Constraint):
    # Open hours for a section: activities may only run inside [open, close]. Unlike time_window
    # (absolute minutes, day-1 only), open/close are a DAILY clock that repeats every day across
    # the horizon, so "09:00–17:00" closes each night, not just day 1.
    type: Literal["working_window"] = "working_window"
    section: str = "all"   # "all" = every activity; otherwise match Activity.section
    open: str = "09:00"    # open <  close = same-day window
    close: str = "17:00"   # open >= close = overnight wrap (the open span crosses midnight)
    # Which 0-based day indices the window applies to. "all" = every day in the horizon.
    days: Union[Literal["all"], list[int]] = "all"

    _check_times = field_validator("open", "close")(_validate_hhmm)

    @field_validator("days")
    @classmethod
    def _check_days(cls, v):
        if v == "all":
            return v
        if not v or any(d < 0 for d in v):
            raise ValueError("days must be 'all' or a list of non-negative day indices")
        return v


class Overlap(_Constraint):
    # Tie two one-off activities together in TIME. mode="contains": `outer` fully covers `inner`
    # (outer.start <= inner.start AND inner.end <= outer.end) — e.g. "comms coverage runs DURING the
    # EVA tasks". mode="overlaps": the two intervals merely share at least one minute. Display-and-
    # solve; references must be one-off ids (a recurring activity's occurrence key is "<id>#d<n>").
    type: Literal["overlap"] = "overlap"
    outer: str
    inner: str
    mode: Literal["contains", "overlaps"] = "contains"


class SectionBudget(_Constraint):
    # A time BUDGET for a section: the total busy minutes of every activity in that section must
    # stay within `max_minutes`. It only bounds a SUM (not placement), so it can't shuffle the
    # timeline — the only way it makes a plan INFEASIBLE is a cap below the section's fixed total.
    type: Literal["section_budget"] = "section_budget"
    section: str            # matches Activity.section
    max_minutes: int        # cap on total busy minutes in the section

    @field_validator("max_minutes")
    @classmethod
    def _check_max(cls, v):
        if v <= 0:
            raise ValueError("max_minutes must be a positive number of minutes")
        return v


class TimeLag(_Constraint):
    # A relative-timing bound between two activities — RCPSP "generalized precedence" / min-max time
    # lag. The lag is (to_anchor of to_id) minus (from_anchor of from_id), in minutes; min_lag/max_lag
    # bound it (at least one is required). One parametric type covers several real rules:
    #   "X immediately before Y" (adjacency) -> from_anchor end, to_anchor start, min_lag=max_lag=0
    #   "meals <= 6h apart" (max-gap)        -> end->start, max_lag=360
    #   "awake <= 16h30m wake->pre-sleep"    -> end(sleep)->start(pre_sleep), max_lag=990
    # On RECURRING activities the solver pairs occurrences by day; day_shift offsets to_id's day so
    # day_shift=1 pairs from_id's night-N occurrence with to_id's day-(N+1) one (the cross-midnight
    # case). A reference to a missing/dropped activity makes the bound vacuous, never infeasible.
    type: Literal["time_lag"] = "time_lag"
    from_id: str
    to_id: str
    from_anchor: Literal["start", "end"] = "end"
    to_anchor: Literal["start", "end"] = "start"
    min_lag: Optional[int] = None  # minutes; lag must be >= this
    max_lag: Optional[int] = None  # minutes; lag must be <= this
    day_shift: int = 0             # pair from_id#dN with to_id#d(N+day_shift) for recurring activities

    @model_validator(mode="after")
    def _check_lags(self):
        if self.min_lag is None and self.max_lag is None:
            raise ValueError("time_lag needs at least one of min_lag / max_lag")
        if (self.min_lag is not None and self.max_lag is not None
                and self.min_lag > self.max_lag):
            raise ValueError("time_lag min_lag must be <= max_lag")
        return self


class MinSeparation(_Constraint):
    # Keep two activities at least `gap` minutes apart, in EITHER order (a both-directions
    # disjunction). Unlike no_overlap — which lets intervals touch (end == start) — this forces a real
    # gap, e.g. "exercise >= 30m from any meal", ">= 10m buffer between two tasks". On recurring
    # activities the solver pairs occurrences by day (day_shift offsets like TimeLag). A reference to
    # a missing/dropped activity makes it vacuous.
    type: Literal["min_separation"] = "min_separation"
    a: str
    b: str
    gap: int           # minutes; must be > 0
    day_shift: int = 0

    @field_validator("gap")
    @classmethod
    def _check_gap(cls, v):
        if v <= 0:
            raise ValueError("min_separation gap must be a positive number of minutes")
        return v


# The discriminated union: pick the variant by its "type" field.
Constraint = Annotated[
    Union[
        TimeWindow, NoOverlap, Precedence, Sequence, Conditional,
        WorkingWindow, SectionBudget, Overlap, TimeLag, MinSeparation,
    ],
    Field(discriminator="type"),
]


class Scenario(BaseModel):
    activities: list[Activity]
    constraints: list[Constraint]
    # Planning window in minutes. None = one 24h day (1440), the default single-day
    # plan. Set it bigger (e.g. 2880 = 2 days) and the solver places activities
    # across the whole window, not just one day.
    horizon: Optional[int] = None

    @field_validator("horizon", mode="before")
    @classmethod
    def _reject_bool_horizon(cls, v):
        # Runs BEFORE coercion (an "after" validator would already see True as 1). Reject bools so
        # `"horizon": true` is a clean error, not a silent 1-minute window.
        if isinstance(v, bool):
            raise ValueError("horizon must be a number of minutes, not a boolean")
        return v

    @field_validator("horizon")
    @classmethod
    def _check_horizon(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v <= 0:
            raise ValueError("horizon must be a positive number of minutes")
        return v

    @model_validator(mode="after")
    def _fill_ids(self):
        # Local LLMs often omit the constraint "id"; give each blank one a stable, unused id.
        # The UI addresses constraints BY id (the enable toggle, the "why infeasible" disable
        # button), so ids must be unique — fill blanks without colliding, then reject any duplicates
        # rather than letting the UI silently target the wrong rule.
        used = {c.id for c in self.constraints if c.id}
        n = 1
        for c in self.constraints:
            if not c.id:
                while f"c{n}" in used:
                    n += 1
                c.id = f"c{n}"
                used.add(c.id)
        ids = [c.id for c in self.constraints]
        if len(ids) != len(set(ids)):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            raise ValueError("constraint ids must be unique; duplicate(s): " + ", ".join(dupes))
        return self
