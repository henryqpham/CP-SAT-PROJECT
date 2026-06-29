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


class Activity(BaseModel):
    id: str
    duration: int  # minutes
    section: Optional[str] = None  # free-text group; same section = one at a time


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


# The discriminated union: pick the variant by its "type" field.
Constraint = Annotated[
    Union[TimeWindow, NoOverlap, Precedence, Sequence, Conditional],
    Field(discriminator="type"),
]


class Scenario(BaseModel):
    activities: list[Activity]
    constraints: list[Constraint]
    # Planning window in minutes. None = one 24h day (1440), the default single-day
    # plan. Set it bigger (e.g. 2880 = 2 days) and the solver places activities
    # across the whole window, not just one day.
    horizon: Optional[int] = None

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
