# `data/scenarios/` — editable rule sets

Each YAML here is one **scenario**: tunable rules layered on the immutable `data/source/` data.
This is the only place you edit to change constraints.

To experiment: copy `example.yaml`, change a rule, solve it, then compare against another scenario.

| Field | Meaning |
|-------|---------|
| `name` | Scenario label (match the filename). |
| `description` | What this scenario represents. |
| `day_start` / `day_end` | `"HH:MM"` bounds the schedule must fit inside. |
| `rules.exercise_gap_after_meal_min` | Minutes after a meal ends before an `exercise` activity may start. |
| `objective` | What to optimize (your solver defines the options). |
| `solver.max_time_seconds` | CP-SAT time budget per solve. |
