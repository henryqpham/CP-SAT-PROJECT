# CLAUDE.md

Natural-language scheduling optimizer: a sentence — or a large `.docx` requirements document —
becomes editable JSON constraints, CP-SAT solves them (single-day or multi-week), a dashboard
shows the result. One local Flask app, Python only. See README.md for the architecture and data flow.

## Commands

- Install deps: `pip install -r requirements.txt`
- Pull the local parse model (one-time): `ollama pull granite4.1:8b` (install Ollama from ollama.com first)
- Run: `flask --app app run --debug` — dashboard at http://localhost:5000
- Use without the LLM: GET `/example` (the demo IR), or POST `examples/lake.json` to `/solve`
- Green-gate tests: `python smoke.py` (lake→OPTIMAL, tight→INFEASIBLE, project→multi-day, plus the
  infeasibility explainer). Run after every change.
- Regenerate the synthetic test doc: `python testdata/make_sample_docx.py`
- Solver tuning (multi-day only) via env: `SOLVER_BUCKET_MINUTES` (default 15), `SOLVER_TIME_LIMIT_SECONDS` (10), `SOLVER_WORKERS` (8).

## Structure

- `app.py` — Flask routes: `/` (dashboard), `/parse` (Ollama, one sentence), `/solve` (CP-SAT;
  attaches a conflict explanation on INFEASIBLE), `/upload` (.docx → structured blocks),
  `/extract` (blocks → multi-day Scenario, SSE progress), `/example[/<name>]` (demo IR), `/examples` (manifest)
- `models.py` — Pydantic IR; the JSON contract shared by every route, the dashboard, and the solver
- `parse.py` — a local Ollama model turns ONE sentence into a validated `Scenario` (single-day path)
- `ingest.py` — python-docx: a `.docx` → ordered structured blocks (section, requirement ids, dates), with provenance
- `extract.py` — map-reduce: blocks → chunk → per-chunk LOCAL Ollama draft → merge/dedup → multi-day `Scenario` + coverage report
- `solver.py` — turns a `Scenario` into a CP-SAT model (single-day OR multi-day) and solves it; `explain_infeasibility` names conflicts
- `templates/index.html`, `static/app.js`, `static/style.css` — the vanilla-JS dashboard (editable cards + multi-day Gantt)
- `examples/lake.json` (single-day demo), `examples/project.json` (multi-day demo)
- `smoke.py` — the runnable green-gate harness + `verify_schedule` (asserts every constraint holds)
- `testdata/make_sample_docx.py` — generates a ~15-page synthetic requirements `.docx` for testing ingestion

## Conventions

- IMPORTANT: Do NOT `git commit` on your own — make the edits, then let the owner review and
  commit. Go through the owner first, and also before any destructive git op (`reset`,
  `revert`, `checkout --`, `push --force`).
- Before changing code, read README.md, then the file(s) you are about to change.
- When you change a module, a command, the folder layout, or the IR in `models.py`, update
  README.md and its mermaid diagram in the same change.
- Add a new constraint type in `models.py` first, then handle it in `solver.py` and render it
  in `static/app.js` — the IR is the single contract; keep the three in sync.
- Times are `Moment`s: a bare `"HH:MM"` (= day 0) OR `{day, time}`. A day-0 Moment serializes back
  to a bare string, so single-day scenarios are byte-unchanged. The solver has an explicit
  `is_multi_day` fork — keep the single-day branch identical so the existing flow never regresses.
- Validate the parsed/extracted constraints, not just the solve result: an LLM can return a
  valid-looking schedule while dropping a rule, so keep each item's `source` phrase and show it.
  For documents this is enforced by `extract.py`'s deterministic backbone + reconciliation/coverage
  report (every `[VR-xxx]` must be accounted for) — the LLM only drafts; it can never silently drop.
- Parsing/extraction run on a LOCAL Ollama model by design (privacy: no data leaves the machine)
  — no cloud LLM calls, no API keys, and `.docx` is parsed in-memory (nothing written to disk).
  Don't reintroduce a hosted API. Override the model with `OLLAMA_MODEL`; read config from the
  environment, never hardcode it.
- New Python dependencies go in `requirements.txt` in the same change that imports them.

## Testing

- `python smoke.py` is the green gate — run it after every change. It must end with `GREEN GATE PASSED`.
  It checks: `examples/lake.json` → `OPTIMAL`; the tight-window variant (drive_to_lake `earliest`
  `21:00` while drive_home `latest_end` `22:00`) → `INFEASIBLE`; `examples/project.json` (multi-day)
  → solved with every constraint verified by `verify_schedule`; and the infeasibility explainer.
- Tests assert STATUS + constraint SATISFACTION (via `verify_schedule`), never exact start times —
  multi-day runs with parallel workers + a time limit are non-deterministic.
- Document ingestion: `python testdata/make_sample_docx.py` then run it through `ingest.extract_blocks`
  + `extract.extract_document`; the coverage report must show every requirement id accounted for
  (the deterministic backbone holds even if the local model returns garbage for some chunks).
