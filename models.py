# Pydantic models for the intermediate representation (IR).
# The LLM produces this; the user edits it; solver.py turns it into CP-SAT.
import re
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer, model_validator

# "HH:MM" with HH 00..24 and MM 00..59; "24:00" is the allowed end-of-day
# sentinel, so accept hour 24 but reject anything past it (e.g. "24:30").
_HHMM = re.compile(r"^([01]\d|2[0-4]):([0-5]\d)$")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DAY_MINUTES = 24 * 60  # one day = 1440 minutes


def _validate_hhmm(v: Optional[str]) -> Optional[str]:
    # Shared by every "HH:MM" field; None (when allowed) passes through.
    if v is None:
        return v
    if not _HHMM.match(v) or v > "24:00":
        raise ValueError(f"expected HH:MM time (00:00–24:00), got {v!r}")
    return v


class Moment(BaseModel):
    """An absolute point in time, as minutes from project start (day 0 == today).

    Accepts EITHER a bare "HH:MM" string (interpreted as day 0) OR an object
    {"day": N, "time": "HH:MM"}. This keeps every existing single-day scenario
    valid — a plain "08:00" still means 08:00 today — while letting a multi-day
    schedule say {"day": 3, "time": "09:00"}. To preserve the original JSON shape
    (and the dashboard's plain-string editor), a day-0 Moment serializes back to a
    bare "HH:MM" string; only day>0 Moments serialize as the {day, time} object.
    """

    # extra="forbid" so a typo'd key (e.g. {"day":3,"tinme":"09:00"}) errors loudly
    # instead of silently dropping to the wrong time; `time` is required so a partial
    # object ({"day":3}) can't silently default to midnight.
    model_config = ConfigDict(extra="forbid")

    day: int = Field(default=0, ge=0, le=3660)  # whole days from project start (cap ~10y)
    time: str                                   # "HH:MM" within that day (required)

    _check_time = field_validator("time")(_validate_hhmm)

    @model_validator(mode="before")
    @classmethod
    def _coerce_str(cls, v):
        # A bare "HH:MM" means day 0 — so Moment is constructible from a string too,
        # not only via the TimeWindow field coercion below.
        return {"day": 0, "time": v} if isinstance(v, str) else v

    def to_minutes(self) -> int:
        hours, minutes = self.time.split(":")
        return self.day * DAY_MINUTES + int(hours) * 60 + int(minutes)

    @model_serializer
    def _serialize(self):
        # Day 0 -> bare "HH:MM" (byte-compatible with the original IR); day>0 -> object.
        return self.time if self.day == 0 else {"day": self.day, "time": self.time}


def _coerce_moment(v):
    """Normalize a Moment field's input: bare "HH:MM" -> day 0; pass dict/Moment/None through.

    Used as a mode="before" validator so a single, explicit code path handles both
    shapes (rather than a raw Union, whose smart-matching mangles malformed objects).
    """
    if v is None or isinstance(v, Moment):
        return v
    if isinstance(v, str):
        return {"day": 0, "time": v}  # Moment's own validator then checks the time
    if isinstance(v, dict):
        return v
    raise ValueError(f"expected 'HH:MM' or {{day, time}}, got {type(v).__name__}")


class Activity(BaseModel):
    id: str
    duration: int  # minutes (a multi-day task is just a large number)
    # Provenance + display, carried end-to-end so a human can verify each item
    # against the source document. Default empty so existing IRs stay valid.
    label: str = ""        # human-readable name (id is snake_case)
    source: str = ""       # the exact requirement text/phrase it came from
    section: str = ""      # heading breadcrumb, for grouping in the UI
    resource: Optional[str] = None  # activities sharing a resource get an auto no_overlap


class _Constraint(BaseModel):
    # Fields every constraint shares; each variant below adds its own `type` + data.
    id: str = ""  # auto-filled (c1, c2, …) by Scenario if the LLM omits it
    enabled: bool = True
    label: str = ""
    source: str = ""


class TimeWindow(_Constraint):
    type: Literal["time_window"] = "time_window"
    activity: str
    earliest: Optional[Moment] = None    # "HH:MM" or {day, time}
    latest_end: Optional[Moment] = None  # "HH:MM" or {day, time}

    _coerce = field_validator("earliest", "latest_end", mode="before")(_coerce_moment)

    @model_validator(mode="after")
    def _check_earliest(self):
        # "24:00" is an end-of-day sentinel — meaningful as a deadline (latest_end)
        # but not as a start. Reject it on `earliest`; use the next day at 00:00.
        if self.earliest is not None and self.earliest.time == "24:00":
            raise ValueError("earliest cannot be 24:00; use {day: <next>, time: '00:00'}")
        return self


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


# The discriminated union: pick the variant by its "type" field.
Constraint = Annotated[
    Union[TimeWindow, NoOverlap, Precedence, Sequence, Conditional],
    Field(discriminator="type"),
]


class DayWindow(BaseModel):
    # The whole day's bounds. Unlike a single time_window (which limits one
    # activity), this bounds EVERY activity — "my day runs 8 AM to 10 PM".
    # Single-day only: in a multi-day scenario the day window does NOT apply as
    # per-day working hours (that's a separate calendar feature, out of scope).
    start: str = "00:00"  # "HH:MM"
    end: str = "24:00"    # "HH:MM"

    _check_times = field_validator("start", "end")(_validate_hhmm)


class Scenario(BaseModel):
    activities: list[Activity]
    constraints: list[Constraint]
    day: Optional[DayWindow] = None
    # Multi-day extensions (both optional; absent => single-day, unchanged behavior):
    start_date: Optional[str] = None              # ISO "YYYY-MM-DD", day 0 — DISPLAY ONLY
    horizon_days: Optional[int] = Field(default=None, ge=1, le=365)  # bounds the horizon

    @field_validator("start_date")
    @classmethod
    def _check_start_date(cls, v):
        if v is not None and not _ISO_DATE.match(v):
            raise ValueError(f"start_date must be ISO 'YYYY-MM-DD', got {v!r}")
        return v

    @model_validator(mode="after")
    def _fill_ids(self):
        # Local LLMs often omit the constraint "id"; give each one a stable id.
        for i, c in enumerate(self.constraints, 1):
            if not c.id:
                c.id = f"c{i}"
        return self

    @property
    def is_multi_day(self) -> bool:
        """True when the scenario opts into the multi-day model: an explicit
        horizon, or any time_window Moment that lands beyond day 0. Single-day
        scenarios (the existing flow) report False and take the unchanged path."""
        if self.horizon_days is not None:
            return True
        for c in self.constraints:
            if isinstance(c, TimeWindow):
                for m in (c.earliest, c.latest_end):
                    if m is not None and m.day > 0:
                        return True
        return False
