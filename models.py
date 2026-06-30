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
    section: Optional[str] = None  # free-text group; same section = one at a time
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
    source: str = ""


class TimeWindow(_Constraint):
    type: Literal["time_window"] = "time_window"
    activity: str
    earliest: Optional[str] = None    # "HH:MM"
    latest_end: Optional[str] = None  # "HH:MM"

    _check_times = field_validator("earliest", "latest_end")(_validate_hhmm)


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


# The discriminated union: pick the variant by its "type" field.
Constraint = Annotated[
    Union[TimeWindow, NoOverlap, Precedence, Sequence, Conditional, WorkingWindow],
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
        # Local LLMs often omit the constraint "id"; give each one a stable id.
        for i, c in enumerate(self.constraints, 1):
            if not c.id:
                c.id = f"c{i}"
        return self
