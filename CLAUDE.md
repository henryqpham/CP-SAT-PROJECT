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
- Benchmark extraction: `python bench_extract.py` (add `--no-llm` for the deterministic-only path)
- Regenerate the synthetic test doc: `python testdata/make_sample_docx.py`
- Solver tuning (multi-day only) via env: `SOLVER_BUCKET_MINUTES` (default 15), `SOLVER_TIME_LIMIT_SECONDS` (10), `SOLVER_WORKERS` (8).

## Structure

- `app.py` — Flask routes: `/` (dashboard), `/parse` (Ollama, one sentence), `/solve` (CP-SAT;
  attaches a conflict explanation on INFEASIBLE), `/upload` (.docx → structured blocks),
  `/extract` (blocks → multi-day Scenario, SSE progress), `/example[/<name>]` (demo IR), `/examples` (manifest)
- `models.py` — Pydantic IR; the JSON contract shared by every route, the dashboard, and the solver
- `parse.py` — a local Ollama model turns ONE sentence into a validated `Scenario` (single-day path)
- `ingest.py` — python-docx: a `.docx` → ordered structured blocks (section, requirement ids, dates), with provenance
- `extract_det.py` — the deterministic backbone: `ingest.py` blocks → activities (id/label/section/source/duration)
  + constraints (dependencies/resources/dated milestones) by regex, no LLM
- `extract.py` — deterministic-FIRST orchestrator: rules first (`extract_det`), local Ollama only on the residual
  rules can't resolve; merge + method-tagged coverage report
- `bench_extract.py` — before/after extraction benchmark + regression harness for the doc pipeline
- `solver.py` — turns a `Scenario` into a CP-SAT model (single-day OR multi-day) and solves it; `explain_infeasibility` names conflicts
- `templates/index.html`, `static/*.js`, `static/style.css` — the vanilla-JS dashboard (framework-free,
  no build step). JS is split into classic `<script>` modules loaded in order: `core.js` (shared
  state/helpers + `render()`), `editor.js` (editable cards + Moment/sequence editors), `gantt.js`
  (single + multi-day timeline), `coverage.js` (the coverage/trust panel), `upload.js` (.docx import),
  `main.js` (wiring, loaded last). One hand-written `style.css` (design tokens + per-area sections).
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
  For documents this is enforced by `extract_det.py`'s deterministic backbone + `extract.py`'s
  reconciliation/coverage report (every `[VR-xxx]` must be accounted for) — the LLM only fills the
  residual; it can never silently drop a requirement.
- Document extraction is DETERMINISTIC-FIRST: rules (`extract_det.py`) resolve
  durations/resources/dependencies/dates over the ordered blocks; the local LLM is a SCOPED fallback
  for the residual only. Deterministic dependency edges are authoritative — do NOT loosen the narrow
  dependency regex / narration guard, and the LLM fallback must never create an edge the rules
  excluded. The coverage report records the extraction method (deterministic/llm/default) per item.
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
  It also asserts the sample doc extracts DETERMINISTICALLY (29/29 requirements, 28 real precedence
  edges, the planted self-loop preserved, zero residual / zero LLM calls) and that the residual LLM
  fallback can never resurrect a narration edge.
- Tests assert STATUS + constraint SATISFACTION (via `verify_schedule`), never exact start times —
  multi-day runs with parallel workers + a time limit are non-deterministic.
- Document ingestion: `python testdata/make_sample_docx.py` then run it through `ingest.extract_blocks`
  + `extract.extract_document`; the coverage report must show every requirement id accounted for
  (the deterministic backbone holds even if the local model returns garbage for some chunks).
