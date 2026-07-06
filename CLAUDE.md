# CLAUDE.md

Manual "what-if" schedule planner: you build editable JSON constraints by hand in a grid, CP-SAT
solves them, a dashboard shows a live timeline. One local Flask app, Python only. The AI sentence
path (`/parse`, local Ollama) is DORMANT for now; re-activating it to ingest documents is the MVP
target (see REQUIREMENTS.md). See README.md for the
architecture and data flow.

## Commands

- Install deps: `pip install -r requirements.txt`
- Run: `flask --app app run --debug` — dashboard at http://localhost:5000
- Test EVERYTHING: `python run_tests.py` (backend pytest + jsdom UI tests; UI part needs a one-time
  `npm install` inside tests/ui). Backend only: `python -m pytest`.
- Normal use (no LLM): build a plan in the dashboard (or load the lake example), or POST a scenario JSON body to `/solve`
- AI features (extract residual fields, `/doc_chat`, `/assist`; dormant `/parse`): needs Ollama
  (install from ollama.com, then `ollama pull granite4.1:8b` and `ollama pull nomic-embed-text`).

## Structure

- `app.py` — Flask routes: `/` (dashboard), `/solve`, `/fill` (pack the window), `/explain`, `/relax`, `/extract` (.docx ingest, genre auto-detect), `/doc_chat`, `/assist`, `/example[/<name>]` + `/examples`. `/parse` (Ollama) is kept but dormant.
- `models.py` — Pydantic IR; the JSON contract shared by the dashboard and `/solve` (and dormant `/parse`)
- `parse.py` — DORMANT: a local Ollama model turns a sentence into a validated `Scenario` (off for the MVP)
- `solver.py` — `Scenario` -> CP-SAT: `solve()` (live), `solve_fill()` (packing, separate objective), `explain_infeasible()`, `relax_by_priority()`
- `ingest.py` / `extract_det.py` / `extract.py` / `extract_sched.py` — the .docx pipeline (blocks -> genre dispatch -> spec rules or schedule rules)
- `doc_chat.py` — Ask the doc (local RAG with cited sources); `assistant.py` — plan assistant (typed tool-calling)
- `templates/index.html`, `static/app.js`, `static/style.css` — the vanilla-JS dashboard
- `static/library.json` — runtime data for the activity library (types + templates); no content is hardcoded in the JS
- `tests/` + `tests/ui/` + `run_tests.py` — the permanent suite (suite tests stay; scratch probes still get deleted)

## Conventions

- **IMPORTANT: Do NOT `git commit` on your own** — make the edits, then let the owner review and
  commit. Ask the owner first before any destructive git op (`reset`, `revert`, `checkout --`, `push --force`).
- Before changing code, read README.md, then the file(s) you are about to change.
- **The IR in `models.py` is the single contract.** To add a constraint type: edit `models.py`
  first, then handle it in `solver.py`, then render it in `static/app.js` — keep all three in sync.
- When you change a module, a command, the folder layout, or the IR, update README.md and its
  mermaid diagram in the same change.
- **Do NOT hardcode content/data in app code:** no baked-in example scenarios, no `const` palettes
  or type→color maps. Runtime data goes in a data file (e.g. `static/library.json`), colors in CSS
  vars. Sensible UI defaults (like a new activity's default duration) are fine — that's UX, not content.
- Validate the parsed constraints, not just the solve result: an LLM can return a valid-looking
  schedule while dropping a rule, so keep each constraint's `source` phrase and show it.
- Parsing is LOCAL Ollama only (privacy: no data leaves the machine) — no cloud LLM calls, no
  API keys, no hosted API. Model comes from the `OLLAMA_MODEL` env var; read config from the
  environment, never hardcode it.
- New Python dependencies go in `requirements.txt` in the same change that imports them.

## Testing

- After a change, run the suite: `python run_tests.py` must be green. It already covers the
  classic smokes (lake `OPTIMAL`; lake with `drive_to_lake.earliest` = `21:00` → `INFEASIBLE`;
  the sample spec doc 29/29; the artemis schedule doc oracle).
- Every new feature adds its tests to `tests/` (and `tests/ui/` for dashboard flows) in the same change.
- Suite tests are permanent. Scratch probes / temporary instrumentation still get deleted after use.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
