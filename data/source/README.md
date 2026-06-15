# `data/source/` — immutable source of truth

Your original inputs. Code only **reads** these; nothing writes back here.

- `activities.yaml` — flexible activities CP-SAT places in time.
- `fixed_events.yaml` — pinned events (meals, meetings) the solver works around.

Tunable rules go in `data/scenarios/`, not here — that separation is what lets `git diff` show
exactly what you changed versus the original.
