-- ============================================================================
-- Relational model of the CP-SAT "what-if" planner IR  (source: models.py)
-- ----------------------------------------------------------------------------
-- The Pydantic IR in models.py is the real single contract. This file is a
-- faithful RELATIONAL projection of it, so the design can live in a diagram
-- tool (DrawDB / ChartDB) and be version-controlled as plain text.
--
-- Flavor: PostgreSQL. Import into DrawDB via  Import > SQL > PostgreSQL.
--
-- Fidelity notes (read these — they explain the non-obvious modelling calls):
--  * A `scenario` is one editable plan = activities + constraints + a horizon.
--  * Constraints are a DISCRIMINATED UNION in the IR (one `type` field picks
--    the variant). Here that is class-table inheritance: one `plan_constraint`
--    base row + exactly one detail row in the matching `c_*` table (1:1 on
--    constraint_id).
--  * Activity references INSIDE constraints are by the activity's STRING id
--    (`activity.ext_id`). The IR DELIBERATELY tolerates a dangling ref (a
--    missing ref just makes the rule vacuous, never an error). So those columns
--    are SOFT references — plain TEXT, NOT enforced foreign keys. Each is
--    marked "SOFT ref -> activity.ext_id" below.
--  * Only the ownership edges (scenario->activity, scenario->constraint,
--    base->detail, and the two junctions) are real, enforced FKs.
-- ============================================================================


-- One editable plan. --------------------------------------------------------
CREATE TABLE scenario (
    scenario_id  BIGSERIAL PRIMARY KEY,
    name         TEXT    NOT NULL DEFAULT 'untitled',
    -- Planning window in minutes. NULL = one 24h day (1440). Must be > 0 if set.
    horizon_min  INTEGER,
    CONSTRAINT horizon_positive CHECK (horizon_min IS NULL OR horizon_min > 0)
);


-- A thing to place on the timeline. -----------------------------------------
CREATE TABLE activity (
    activity_id   BIGSERIAL PRIMARY KEY,
    scenario_id   BIGINT  NOT NULL REFERENCES scenario(scenario_id) ON DELETE CASCADE,
    ext_id        TEXT    NOT NULL,              -- IR string id (snake_case); unique per scenario
    duration_min  INTEGER NOT NULL,             -- minutes; >= 1 (0/negative would wedge the solver)
    label         TEXT    NOT NULL DEFAULT '',   -- human-readable name
    source        TEXT    NOT NULL DEFAULT '',   -- verbatim provenance phrase (doc-ingest)
    section       TEXT,                          -- group; same section = one-at-a-time resource
    assignee      TEXT,                          -- DISPLAY-ONLY swimlane owner (solver ignores)
    activity_type TEXT,                          -- DISPLAY-ONLY category: bar color / group-by
    recurs_daily  BOOLEAN NOT NULL DEFAULT FALSE,-- true = expand to one occurrence per day
    days_mode     TEXT    NOT NULL DEFAULT 'all',-- 'all', or 'list' -> see activity_day rows
    dw_open       TEXT,                          -- daily_window open  "HH:MM" (only when recurring)
    dw_close      TEXT,                          -- daily_window close "HH:MM"
    CONSTRAINT duration_positive CHECK (duration_min >= 1),
    CONSTRAINT days_mode_valid   CHECK (days_mode IN ('all','list')),
    CONSTRAINT uq_activity_ext   UNIQUE (scenario_id, ext_id)
);

-- The 0-based day indices a recurring activity recurs on (only when days_mode='list').
CREATE TABLE activity_day (
    activity_id  BIGINT  NOT NULL REFERENCES activity(activity_id) ON DELETE CASCADE,
    day_index    INTEGER NOT NULL,
    PRIMARY KEY (activity_id, day_index),
    CONSTRAINT day_index_nonneg CHECK (day_index >= 0)
);


-- Constraint base: the fields every rule shares (the _Constraint mixin). -----
-- `plan_constraint`, not `constraint` — the latter is a reserved SQL word.
CREATE TABLE plan_constraint (
    constraint_id BIGSERIAL PRIMARY KEY,
    scenario_id   BIGINT  NOT NULL REFERENCES scenario(scenario_id) ON DELETE CASCADE,
    ext_id        TEXT    NOT NULL,              -- c1, c2, ...; unique per scenario
    ctype         TEXT    NOT NULL,              -- discriminator: picks the c_* detail table
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    label         TEXT    NOT NULL DEFAULT '',
    source        TEXT    NOT NULL DEFAULT '',   -- verbatim provenance phrase
    priority      INTEGER NOT NULL DEFAULT 1,    -- 1 = hard/inviolable .. 5 = dropped first
    rationale     TEXT    NOT NULL DEFAULT '',   -- human WHY
    CONSTRAINT priority_range   CHECK (priority BETWEEN 1 AND 5),
    CONSTRAINT uq_constraint_ext UNIQUE (scenario_id, ext_id),
    CONSTRAINT ctype_valid CHECK (ctype IN (
        'time_window','no_overlap','precedence','sequence','conditional',
        'working_window','section_budget','overlap','time_lag','min_separation'))
);


-- Detail tables — one row per matching base row (1:1 on constraint_id). ------

-- time_window: an activity must run within [earliest, latest_end] on a given day.
CREATE TABLE c_time_window (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    activity_ref  TEXT NOT NULL,    -- SOFT ref -> activity.ext_id
    earliest      TEXT,             -- "HH:MM"
    latest_end    TEXT,             -- "HH:MM"
    day_index     INTEGER           -- 0-based day the clock applies to (NULL = day 0)
);

-- precedence: before_ref ends before after_ref starts.
CREATE TABLE c_precedence (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    before_ref    TEXT NOT NULL,    -- SOFT ref -> activity.ext_id (ends first)
    after_ref     TEXT NOT NULL     -- SOFT ref -> activity.ext_id (starts after)
);

-- conditional: if `when_json` holds, apply `then_json`. Both are free-form in the IR.
CREATE TABLE c_conditional (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    when_json     JSONB NOT NULL,   -- e.g. {"activity":"kiteboard","present":false}
    then_json     JSONB NOT NULL    -- e.g. {"set_duration":{"activity":"sail","factor":2}}
);

-- working_window: a section's activities may only run inside [open,close], repeating daily.
CREATE TABLE c_working_window (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    section       TEXT NOT NULL DEFAULT 'all',   -- 'all' = every activity, else Activity.section
    open_time     TEXT NOT NULL DEFAULT '09:00', -- "HH:MM"; open >= close means overnight wrap
    close_time    TEXT NOT NULL DEFAULT '17:00',
    days_mode     TEXT NOT NULL DEFAULT 'all',   -- 'all', or 'list' -> c_working_window_day
    CONSTRAINT ww_days_mode_valid CHECK (days_mode IN ('all','list'))
);

CREATE TABLE c_working_window_day (
    constraint_id BIGINT  NOT NULL REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    day_index     INTEGER NOT NULL,
    PRIMARY KEY (constraint_id, day_index),
    CONSTRAINT ww_day_nonneg CHECK (day_index >= 0)
);

-- section_budget: total busy minutes in a section must stay <= max_minutes.
CREATE TABLE c_section_budget (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    section       TEXT    NOT NULL,   -- matches Activity.section
    max_minutes   INTEGER NOT NULL,
    CONSTRAINT max_minutes_positive CHECK (max_minutes > 0)
);

-- overlap: tie two one-off activities in time (outer contains inner, or they merely overlap).
CREATE TABLE c_overlap (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    outer_ref     TEXT NOT NULL,    -- SOFT ref -> activity.ext_id
    inner_ref     TEXT NOT NULL,    -- SOFT ref -> activity.ext_id
    mode          TEXT NOT NULL DEFAULT 'contains',
    CONSTRAINT overlap_mode_valid CHECK (mode IN ('contains','overlaps'))
);

-- time_lag: min/max minutes between two activity anchors (generalized precedence).
CREATE TABLE c_time_lag (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    from_ref      TEXT    NOT NULL,               -- SOFT ref -> activity.ext_id
    to_ref        TEXT    NOT NULL,               -- SOFT ref -> activity.ext_id
    from_anchor   TEXT    NOT NULL DEFAULT 'end',
    to_anchor     TEXT    NOT NULL DEFAULT 'start',
    min_lag       INTEGER,                        -- minutes; lag >= this
    max_lag       INTEGER,                        -- minutes; lag <= this
    day_shift     INTEGER NOT NULL DEFAULT 0,     -- pair from#dN with to#d(N+day_shift)
    CONSTRAINT from_anchor_valid CHECK (from_anchor IN ('start','end')),
    CONSTRAINT to_anchor_valid   CHECK (to_anchor   IN ('start','end')),
    CONSTRAINT lag_needs_one CHECK (min_lag IS NOT NULL OR max_lag IS NOT NULL),
    CONSTRAINT lag_order     CHECK (min_lag IS NULL OR max_lag IS NULL OR min_lag <= max_lag)
);

-- min_separation: keep two activities at least `gap` minutes apart, in either order.
CREATE TABLE c_min_separation (
    constraint_id BIGINT PRIMARY KEY REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    a_ref         TEXT    NOT NULL,               -- SOFT ref -> activity.ext_id
    b_ref         TEXT    NOT NULL,               -- SOFT ref -> activity.ext_id
    gap           INTEGER NOT NULL,               -- minutes; > 0
    day_shift     INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT gap_positive CHECK (gap > 0)
);


-- Junction for the two list-valued constraints (no_overlap, sequence). -------
-- no_overlap.activities: either the literal 'all' (one row, ext_id='all') or a
--   set of activity ids (position NULL).
-- sequence.activities:   an ORDERED list (position 0,1,2,... gives the order).
CREATE TABLE constraint_activity (
    constraint_id BIGINT  NOT NULL REFERENCES plan_constraint(constraint_id) ON DELETE CASCADE,
    activity_ref  TEXT    NOT NULL,   -- SOFT ref -> activity.ext_id, or the 'all' sentinel
    position      INTEGER,            -- order index for `sequence`; NULL for `no_overlap` set
    PRIMARY KEY (constraint_id, activity_ref)
);
