"""parse_duration: read minutes, prefer the labelled estimate, and never read a cap/cadence.

Before this fix the regex only knew hour/day/week/month, so a "30 minute" task fell through to
an 8-hour default (bit twice in demos: GBORD, then SH-804/AR-235). These cases pin the fix.
"""
import extract_det as det


# ---- minutes are read (the core bug) -----------------------------------------
def test_minutes_read_word_and_abbrev():
    assert det.parse_duration("Estimated duration: 30 minutes.") == 30
    assert det.parse_duration("Estimated duration: 45 min.") == 45
    assert det.parse_duration("Estimated duration: 90 minutes.") == 90
    assert det.parse_duration("Estimated duration: 40 min.") == 40


def test_minutes_over_an_hour_stay_minutes():
    assert det.parse_duration("Estimated duration: 90 minutes.") == 90  # not 1 (hour) or 5400


# ---- hours / decimals / bigger units still work (no regression) --------------
def test_hours_and_decimals():
    assert det.parse_duration("Estimated duration: 1 hour.") == 60
    assert det.parse_duration("Estimated duration: 1.5 hours.") == 90
    assert det.parse_duration("Estimated duration: 2.5 hours.") == 150


def test_days_weeks_months():
    assert det.parse_duration("Estimated validation effort: 3 days") == 4320
    assert det.parse_duration("takes 1 week") == 10080
    assert det.parse_duration("about 2 months") == 86400


# ---- caps and cadences must NOT be read as a duration ------------------------
def test_cap_not_read():
    assert det.parse_duration("The effort shall not exceed 10 hours.") is None
    assert det.parse_duration("Keep meals no more than 6 hours apart.") is None


def test_cadence_not_read():
    assert det.parse_duration("Performed every 7 days.") is None
    assert det.parse_duration("Runs within 2 hours of wake.") is None


def test_label_wins_over_an_earlier_cap_in_the_same_block():
    txt = "The run shall not exceed 12 hours. Estimated duration: 30 minutes."
    assert det.parse_duration(txt) == 30


# ---- first value wins when a block states two (the chosen policy) ------------
def test_first_labelled_value_wins():
    # matches how duplicate requirement blocks merge (first-seen kept)
    txt = "Estimated duration: 20 minutes. ... Estimated duration: 30 minutes."
    assert det.parse_duration(txt) == 20


# ---- false-positive guards ("min" inside a word) -----------------------------
def test_min_inside_a_word_is_not_a_unit():
    assert det.parse_duration("keep 5 minimum runs ready") is None
    assert det.parse_duration("the administration reviewed 3 items") is None


def test_no_duration_returns_none():
    assert det.parse_duration("Owner: SRME. Rationale: ensures coverage.") is None


# ---- caps the guard used to miss (found by the adversarial verify pass) ------
def test_more_cap_phrasings_not_read():
    for txt in (
        "capped at 4 hours",
        "The task shall be capped at 4 hours per shift.",
        "limited to 5 hours",
        "maximum of 3 hours",
        "A maximum duration of 3 hours applies.",
        "no longer than 2 hours",
        "not to exceed 10 hours",
        "less than 3 hours",
        "shall not exceed a total of 10 hours.",
    ):
        assert det.parse_duration(txt) is None, txt


def test_capped_label_is_not_read_as_a_duration():
    # the highest-severity find: a bound stated via the label ("Maximum duration:")
    assert det.parse_duration("Maximum duration: 10 hours") is None
    assert det.parse_duration("Minimum duration: 2 hours") is None
    assert det.parse_duration("Duration limit: 10 hours") is None
    assert det.parse_duration("Duration cap: 10 hours") is None
    assert det.parse_duration("Maximum effort: 10 hours") is None


# ---- em/en dash after the label (previously grabbed an unrelated earlier number) ----
def test_label_with_dash_separator_reads_the_labelled_value():
    assert det.parse_duration("Prep spans 2 hours. Estimated duration — 30 minutes.") == 30
    assert det.parse_duration("Estimated duration – 45 min.") == 45


# ---- compound "Nh Mm" durations sum instead of returning half --------------------
def test_compound_durations_sum():
    assert det.parse_duration("1 hour 30 minutes") == 90
    assert det.parse_duration("Estimated duration: 1 hour 30 minutes") == 90
    assert det.parse_duration("1 hour and 30 minutes") == 90
    assert det.parse_duration("1 hour, 30 minutes") == 90


def test_compound_does_not_fold_ascending_units():
    assert det.parse_duration("2 hours 3 days") == 120  # not summed with the larger unit


# ---- trailing cadence / cap-tail leaks ------------------------------------------
def test_trailing_cadence_not_read():
    assert det.parse_duration("The task shall be performed 3 days per week") is None
    assert det.parse_duration("runs 2 hours/week") is None


def test_cap_tail_does_not_leak_a_duration():
    # the second half ("and 30 minutes") is part of the cap, not a real duration
    assert det.parse_duration("no more than 6 hours and 30 minutes") is None


def test_real_duration_survives_a_nearby_cadence_word():
    # "per day" binds to "3 times", NOT to the real "45 minutes" duration
    assert det.parse_duration("runs 3 times per day for 45 minutes") == 45
