"""IR validation tests (models.py)."""
import pytest
from pydantic import ValidationError

from models import (
    Activity,
    DailyWindow,
    MinSeparation,
    NoOverlap,
    Scenario,
    SectionBudget,
    TimeLag,
    TimeWindow,
    WorkingWindow,
)

GOOD_TIMES = ["00:00", "09:30", "23:59", "24:00"]
BAD_TIMES = ["24:30", "25:00", "9:00", "ab:cd"]


# --- HH:MM validation ---

@pytest.mark.parametrize("t", GOOD_TIMES)
def test_time_window_accepts_valid_times(t):
    tw = TimeWindow(activity="a", earliest=t, latest_end=t)
    assert tw.earliest == t
    assert tw.latest_end == t


@pytest.mark.parametrize("t", BAD_TIMES)
def test_time_window_rejects_bad_times(t):
    with pytest.raises(ValidationError):
        TimeWindow(activity="a", earliest=t)
    with pytest.raises(ValidationError):
        TimeWindow(activity="a", latest_end=t)


@pytest.mark.parametrize("t", GOOD_TIMES)
def test_working_window_accepts_valid_times(t):
    # working_window has no open<close rule (open>=close means overnight wrap)
    assert WorkingWindow(open=t).open == t
    assert WorkingWindow(close=t).close == t


@pytest.mark.parametrize("t", BAD_TIMES)
def test_working_window_rejects_bad_times(t):
    with pytest.raises(ValidationError):
        WorkingWindow(open=t)
    with pytest.raises(ValidationError):
        WorkingWindow(close=t)


def test_daily_window_accepts_valid_times():
    dw = DailyWindow(open="09:30", close="24:00")
    assert dw.open == "09:30"
    assert dw.close == "24:00"


@pytest.mark.parametrize("t", BAD_TIMES)
def test_daily_window_rejects_bad_times(t):
    with pytest.raises(ValidationError):
        DailyWindow(open=t, close="24:00")
    with pytest.raises(ValidationError):
        DailyWindow(open="00:00", close=t)


def test_daily_window_overnight_rejected():
    # open must be strictly before close
    with pytest.raises(ValidationError):
        DailyWindow(open="22:00", close="06:00")
    with pytest.raises(ValidationError):
        DailyWindow(open="12:00", close="12:00")


# --- priority + rationale ---

@pytest.mark.parametrize("p", [1, 2, 3, 4, 5])
def test_priority_accepts_1_to_5(p):
    assert NoOverlap(priority=p).priority == p


@pytest.mark.parametrize("p", [0, 6])
def test_priority_rejects_out_of_range(p):
    with pytest.raises(ValidationError):
        NoOverlap(priority=p)


def test_priority_and_rationale_defaults():
    c = NoOverlap()
    assert c.priority == 1
    assert c.rationale == ""


# --- horizon ---

def test_horizon_bool_rejected():
    with pytest.raises(ValidationError):
        Scenario(activities=[], constraints=[], horizon=True)


@pytest.mark.parametrize("h", [0, -100])
def test_horizon_nonpositive_rejected(h):
    with pytest.raises(ValidationError):
        Scenario(activities=[], constraints=[], horizon=h)


def test_horizon_none_ok():
    assert Scenario(activities=[], constraints=[]).horizon is None


# --- constraint ids ---

def test_blank_constraint_ids_autofill_around_given_ids():
    s = Scenario(
        activities=[],
        constraints=[
            {"type": "no_overlap"},              # blank -> c2 (c1 is taken)
            {"type": "no_overlap", "id": "c1"},
            {"type": "no_overlap"},              # blank -> c3
        ],
    )
    assert [c.id for c in s.constraints] == ["c2", "c1", "c3"]


def test_duplicate_constraint_ids_rejected():
    with pytest.raises(ValidationError) as err:
        Scenario(
            activities=[],
            constraints=[
                {"type": "no_overlap", "id": "c1"},
                {"type": "no_overlap", "id": "c1"},
            ],
        )
    assert "duplicate" in str(err.value)
    assert "c1" in str(err.value)


# --- days field ---

def test_activity_days_all_and_list_ok():
    assert Activity(id="a", duration=30).days == "all"
    assert Activity(id="a", duration=30, days=[0, 2]).days == [0, 2]


def test_activity_days_rejects_empty_and_negative():
    with pytest.raises(ValidationError):
        Activity(id="a", duration=30, days=[])
    with pytest.raises(ValidationError):
        Activity(id="a", duration=30, days=[-1])


def test_working_window_days_rejects_empty_and_negative():
    assert WorkingWindow().days == "all"
    with pytest.raises(ValidationError):
        WorkingWindow(days=[])
    with pytest.raises(ValidationError):
        WorkingWindow(days=[-1])


# --- time_lag / min_separation / section_budget bounds ---

def test_time_lag_needs_at_least_one_lag():
    with pytest.raises(ValidationError):
        TimeLag(from_id="a", to_id="b")


def test_time_lag_min_above_max_rejected():
    with pytest.raises(ValidationError):
        TimeLag(from_id="a", to_id="b", min_lag=60, max_lag=30)


def test_time_lag_one_sided_ok():
    assert TimeLag(from_id="a", to_id="b", min_lag=0).min_lag == 0
    assert TimeLag(from_id="a", to_id="b", max_lag=30).max_lag == 30


@pytest.mark.parametrize("gap", [0, -5])
def test_min_separation_rejects_nonpositive_gap(gap):
    with pytest.raises(ValidationError):
        MinSeparation(a="a", b="b", gap=gap)


def test_min_separation_positive_gap_ok():
    assert MinSeparation(a="a", b="b", gap=1).gap == 1


@pytest.mark.parametrize("cap", [0, -10])
def test_section_budget_rejects_nonpositive_cap(cap):
    with pytest.raises(ValidationError):
        SectionBudget(section="ops", max_minutes=cap)


def test_section_budget_positive_cap_ok():
    assert SectionBudget(section="ops", max_minutes=60).max_minutes == 60


# --- Activity defaults ---

def test_activity_defaults():
    a = Activity(id="x", duration=30)
    assert a.label == ""
    assert a.source == ""
    assert a.section is None
    assert a.assignee is None
    assert a.type is None
    assert a.recurs_daily is False
    assert a.daily_window is None
