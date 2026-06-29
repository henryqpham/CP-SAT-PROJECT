# CLAUDE.md

Manual "what-if" schedule planner: you build editable JSON constraints by hand in a grid, CP-SAT
solves them, a dashboard shows a live timeline. One local Flask app, Python only. The AI sentence
path (`/parse`, local Ollama) is DORMANT for now; re-activating it to ingest documents is the MVP
target (see REQUIREMENTS.md). See README.md for the
architecture and data flow.

## Commands

- Install deps: `pip install -r requirements.txt`
- Run: `flask --app app run --debug` — dashboard at http://localhost:5000
- Normal use (no LLM): build a plan in the dashboard (or load the lake example), or POST a scenario JSON body to `/solve`
- Dormant `/parse` only: needs Ollama (install from ollama.com, then `ollama pull granite4.1:8b`).

## Structure

- `app.py` — Flask routes: `/` (dashboard), `/solve` (CP-SAT), `/example[/<name>]` + `/examples` (demo IR + dropdown manifest). `/parse` (Ollama) is kept but dormant.
- `models.py` — Pydantic IR; the JSON contract shared by the dashboard and `/solve` (and dormant `/parse`)
- `parse.py` — DORMANT: a local Ollama model turns a sentence into a validated `Scenario` (off for the MVP)
- `solver.py` — turns a `Scenario` into a CP-SAT model and solves it
- `templates/index.html`, `static/app.js`, `static/style.css` — the vanilla-JS dashboard
- `static/library.json` — runtime data for the activity library (types + templates); no content is hardcoded in the JS

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

- After a change, run `examples/lake.json` through `/solve`: it must return `OPTIMAL`.
- Set `drive_to_lake.earliest` to `21:00` while `drive_home.latest_end` is `22:00`; `/solve` must
  return `INFEASIBLE`. Use this as the smoke test for constraint handling.
- Delete any temporary test code after running it.
