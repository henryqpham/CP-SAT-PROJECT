# Pydantic models for the intermediate representation (IR).
# The LLM produces this; the user edits it; solver.py turns it into CP-SAT.
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field


class Activity(BaseModel):
    id: str
    duration: int  # minutes


class TimeWindow(BaseModel):
    type: Literal["time_window"] = "time_window"
    id: str
    activity: str
    earliest: Optional[str] = None    # "HH:MM"
    latest_end: Optional[str] = None  # "HH:MM"
    enabled: bool = True
    label: str = ""
    source: str = ""


class NoOverlap(BaseModel):
    type: Literal["no_overlap"] = "no_overlap"
    id: str
    activities: Union[Literal["all"], list[str]] = "all"
    enabled: bool = True
    label: str = ""
    source: str = ""


class Precedence(BaseModel):
    type: Literal["precedence"] = "precedence"
    id: str
    before: str  # this activity ends before...
    after: str   # ...this one starts
    enabled: bool = True
    label: str = ""
    source: str = ""


class Conditional(BaseModel):
    type: Literal["conditional"] = "conditional"
    id: str
    when: dict   # e.g. {"activity": "kiteboard", "present": false}
    then: dict   # e.g. {"set_duration": {"activity": "sail", "factor": 2}}
    enabled: bool = True
    label: str = ""
    source: str = ""


# The discriminated union: pick the variant by its "type" field.
Constraint = Annotated[
    Union[TimeWindow, NoOverlap, Precedence, Conditional],
    Field(discriminator="type"),
]


class Scenario(BaseModel):
    activities: list[Activity]
    constraints: list[Constraint]
