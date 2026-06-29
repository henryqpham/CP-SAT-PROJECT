# CP-SAT-PROJECT

A hands-on "what-if" schedule planner. You type activities into a spreadsheet-style grid and a
live timeline shows whether the day still fits. Change one thing — shorten a break, add a second
cleaning — and the timeline redraws by itself, so you can see right away if the plan holds or breaks.

Activities are grouped into **sections** (like Deli, Cheese, FrontDesk — your departments or
stations). The schedule is solved by **CP-SAT** (Google OR-Tools). It's one local Flask app,
Python only — a real, working ops planner.

New to constraint solving? See [ARCHITECTURE.md](ARCHITECTURE.md) for a plain-language tour of the
app and how CP-SAT works.

> Change "break = 1 hour" to "break = 30 min", or "clean toilet ×1" to "×2" — does the day still
> fit, or go red? That question is the whole tool.

## Status

A manual base is working — and the schedule now spans a custom **multi-day horizon**, not just one
day. The rest of the MVP (document ingest, fill objective) is being built on top of it.

**The MVP (the goal):** drop in a large document → a local Ollama model parses it into many
activities, each with its own constraints → pick which to add → schedule them across a **multi-day,
custom horizon** (a 6-day trip, 480 hours, a mission length) → a capacity health bar shows whether
you're **over / under / how much time is left**, with the goal of **filling** the window across all
your sections. See [REQUIREMENTS.md](REQUIREMENTS.md) for the North Star + roadmap.

**Working today (the base):**

- The CP-SAT solver — schedules across a custom **horizon** (one 24h day by default, or several
  days) + the editable JSON IR and its 5 constraint types.
- The timeline (Gantt) — a fitted single-day view, or a multi-day view with per-day markers — plus
  the "On this plan" roster and the searchable Library (with "+ New").
- A capacity health bar (used vs. your horizon: over / under / time left).
- Live auto-solve; keep the last good timeline (dimmed) when a change breaks it.

**Next, toward the MVP (not paused — the actual target):**

- Document ingest + local-Ollama parsing into activities & constraints (re-activates `/parse`).
- A fill / utilization objective so the solver packs the window (the North-Star "fill").
- The crew / section model so many sections pack in parallel.
- Prior art for multi-day + `.docx` ingest lives on `archive/advanced-multiday-classifier` — revive it.

## How it works

Today you build the plan by hand (AI document-ingest is the MVP target — see Status):

1. Add activities in a grid, each with a **duration** and a **section** (Deli, FrontDesk, …).
2. Each section is treated as **one resource** — it can only do one thing at a time, so two
   activities in the same section can't overlap.
3. Add rules as needed: deadlines and earliest-starts (`time_window`), ordering (`precedence` /
   `sequence`), "one thing at a time" (`no_overlap`), and conditionals.
4. The timeline redraws live as you edit. Green means it fits (**OPTIMAL**). Red means the rules
   clash (**INFEASIBLE**). When it goes red, the last working timeline stays on screen, dimmed,
   with a "that change broke it" note — so you never lose the plan you were reasoning about.

No database, no build step, no npm. One Flask app serves the dashboard (`/`) plus these JSON
endpoints:

- **`/solve`** — takes the IR and returns a schedule from CP-SAT.
- **`/example[/<name>]`** — returns a hand-written demo scenario; `/examples` lists them.
- **`/parse`** — the old sentence-to-JSON route, kept but **dormant** (AI is off for now).

```mermaid
flowchart LR
    U(["Mission manager"]) -->|enter / edit activities| FE["Dashboard<br/>grid + live timeline"]

    subgraph FLASK["Flask app (app.py)"]
        direction TB
        SOLVE["/solve<br/>CP-SAT (horizon-bounded)"]
        EXAMPLE["/example<br/>demo IR"]
        MODELS["models.py<br/>Pydantic IR"]
        PARSE["/parse<br/>(dormant — AI off)"]
    end

    FE -->|"edit (debounced auto-solve)"| SOLVE -->|schedule| FE
    FE -->|"Load example"| EXAMPLE -->|editable IR| FE
    MODELS -.validates.-> SOLVE
```

Data flow: **manual grid entry (grouped by section) → live (debounced) CP-SAT → timeline → tweak
and repeat.** It's a flexible loop, not a waterfall: enter, see the timeline, edit the input, add a
rule, watch it react — in any order.

## Structure

```
CP-SAT-PROJECT/
├── app.py               # Flask: / (dashboard), /solve (CP-SAT), /example[/<name>] + /examples (demo IR). /parse kept but dormant.
├── models.py            # Pydantic IR: Activity (+ section) + constraint union — the JSON contract
├── solver.py            # Scenario -> CP-SAT -> schedule (one day by default, or a multi-day horizon); each section becomes a one-at-a-time resource
├── parse.py             # DORMANT: local Ollama sentence -> Scenario (AI path, off for the MVP)
├── examples/lake.json   # hand-written IR to test /solve without any AI
├── templates/index.html
├── static/app.js        # the grid + live timeline; edits auto-solve via /solve
├── static/style.css     # dark "mission control" theme (tokens at :root drive the whole look)
├── static/artemis-logo.png  # topbar logo
├── static/earthrise.jpg     # darkened background photo behind the app
├── requirements.txt
└── .env.example         # OLLAMA_MODEL= (only for the dormant AI path)
```

`solver.py` is the CP-SAT core — it turns each constraint into a CP-SAT call (`add_no_overlap`,
`only_enforce_if`, time-window bounds…) and serializes each section as a single resource. The rest
(`models.py`, `app.py`, `templates/`, `static/`) is the surrounding plumbing.

## The intermediate format (IR)

One typed JSON document you build and edit by hand. Each constraint `type` maps 1:1 to a CP-SAT
call; `enabled` toggles a rule without losing its numbers. The five constraint types are:

- `time_window` — an `earliest` start and/or `latest_end` (`"HH:MM"`) for one `activity`.
- `no_overlap` — a set of `activities` (or `"all"`) that can't run at the same time.
- `precedence` — one activity (`before`) must finish before another (`after`) starts.
- `sequence` — an ordered chain of `activities`; each one ends before the next begins (the
  multi-activity generalization of `precedence`).
- `conditional` — a `when` / `then` rule, e.g. *when* kiteboard is absent, *then* set sail's
  duration ×2.

An **`Activity`** is an `id` and a `duration` in minutes, plus (new for the MVP) an optional
**`section`** — free text like `"Deli"`. Activities sharing a section are automatically serialized
(they can't overlap), which is what makes the what-if real: drop a second task into a busy section
and watch the timeline stretch or go red.

Activities run free across the planning **horizon** — one 24h day by default, or set
`"horizon"` (in minutes) on the scenario for a multi-day window (e.g. `2880` = 2 days). Per-activity
`time_window` constraints are what pin them down — note their `earliest` / `latest_end` are day-1
clock times (absolute minutes from the plan start), so on a multi-day horizon they still hold an
activity inside the first day; per-day deadlines ("by 22:00 on day 3") are a planned follow-up. Full
example in `examples/lake.json`:

```jsonc
{
  "activities": [{ "id": "sail", "duration": 120, "section": "Lake" }],
  "constraints": [
    { "id": "c2", "type": "time_window", "activity": "drive_home",
      "latest_end": "22:00", "enabled": true, "label": "Home by 10 PM" },
    { "id": "c4", "type": "sequence", "activities": ["coffee", "shower", "commute"],
      "enabled": true, "label": "First coffee, then shower, then commute" },
    { "id": "c5", "type": "conditional",
      "when": { "activity": "kiteboard", "present": false },
      "then": { "set_duration": { "activity": "sail", "factor": 2 } },
      "enabled": true, "label": "If no kite, sail twice as long" }
  ]
}
```

In the `conditional` above, `factor: 2` means double the activity's duration, and
`present: false` means "when kiteboard is left out of the schedule."

## Setup & run

```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
flask --app app run --debug     # dashboard at http://localhost:5000
```

No AI and no API key are needed for the MVP — the dashboard, `/solve`, and `/example` run with
nothing external. (The dormant AI path needs Ollama: `ollama pull granite4.1:8b`, override the
model with `OLLAMA_MODEL` — only if you re-enable `/parse`.)

## Notes

- Local-only — no database, no auth, no hosting (privacy: data stays on the machine).
- Manual entry today; AI document-ingest (local Ollama) is the MVP target — the `/parse` path is
  kept dormant for now, not removed.
- The advanced version (multi-day, `.docx` import, document extraction) lives on the branch
  `archive/advanced-multiday-classifier` if it's ever needed again.
