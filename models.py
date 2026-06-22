# Pydantic models for the intermediate representation (IR).
# The LLM produces this; the user edits it; solver.py turns it into CP-SAT.
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator


class Activity(BaseModel):
    id: str
    duration: int  # minutes


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


class NoOverlap(_Constraint):
    type: Literal["no_overlap"] = "no_overlap"
    activities: Union[Literal["all"], list[str]] = "all"


class Precedence(_Constraint):
    type: Literal["precedence"] = "precedence"
    before: str  # this activity ends before...
    after: str   # ...this one starts


class Conditional(_Constraint):
    type: Literal["conditional"] = "conditional"
    when: dict   # e.g. {"activity": "kiteboard", "present": false}
    then: dict   # e.g. {"set_duration": {"activity": "sail", "factor": 2}}


# The discriminated union: pick the variant by its "type" field.
Constraint = Annotated[
    Union[TimeWindow, NoOverlap, Precedence, Conditional],
    Field(discriminator="type"),
]


class DayWindow(BaseModel):
    # The whole day's bounds. Unlike a single time_window (which limits one
    # activity), this bounds EVERY activity — "my day runs 8 AM to 10 PM".
    start: str = "00:00"  # "HH:MM"
    end: str = "24:00"    # "HH:MM"


class Scenario(BaseModel):
    activities: list[Activity]
    constraints: list[Constraint]
    day: Optional[DayWindow] = None

    @model_validator(mode="after")
    def _fill_ids(self):
        # Local LLMs often omit the constraint "id"; give each one a stable id.
        for i, c in enumerate(self.constraints, 1):
            if not c.id:
                c.id = f"c{i}"
        return self
