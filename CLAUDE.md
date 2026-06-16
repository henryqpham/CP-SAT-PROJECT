# CLAUDE.md

Natural-language scheduling optimizer: a sentence becomes editable JSON constraints, CP-SAT
solves them, a dashboard shows the result. One local Flask app, Python only. See README.md for
the architecture and data flow.

## Commands

- Install deps: `pip install -r requirements.txt`
- Run: `flask --app app run --debug` — dashboard at http://localhost:5000
- Solve without the LLM: POST the contents of `examples/lake.json` to `/solve`

## Structure

- `app.py` — Flask routes: `/` (dashboard), `/parse` (Claude), `/solve` (CP-SAT)
- `models.py` — Pydantic IR; the JSON contract shared by `/parse`, the dashboard, and `/solve`
- `parse.py` — Claude turns a sentence into a validated `Scenario`
- `solver.py` — turns a `Scenario` into a CP-SAT model and solves it
- `templates/index.html`, `static/app.js`, `static/style.css` — the vanilla-JS dashboard
- `examples/lake.json` — a hand-written IR for testing `/solve`

## Conventions

- Before changing code, read README.md, then the file(s) you are about to change.
- When you change a module, a command, the folder layout, or the IR in `models.py`, update
  README.md and its mermaid diagram in the same change.
- Add a new constraint type in `models.py` first, then handle it in `solver.py` and render it
  in `static/app.js` — the IR is the single contract; keep the three in sync.
- Validate the parsed constraints, not just the solve result: an LLM can return a valid-looking
  schedule while dropping a rule, so keep each constraint's `source` phrase and show it.
- Keep the Anthropic API key in `.env` (gitignored); read it from the environment, never
  hardcode or commit it.
- New Python dependencies go in `requirements.txt` in the same change that imports them.
- IMPORTANT: `solver.py` (the CP-SAT model) is the owner's to write for learning. Offer hints
  and small isolated examples; do not implement it unless the owner explicitly asks.

## Testing

- After a change, run `examples/lake.json` through `/solve`: it must return `OPTIMAL`.
- Set `drive_to_lake.earliest` to `21:00` while `drive_home.latest_end` is `22:00`; `/solve`
  must return `INFEASIBLE`. Use this as the smoke test for constraint handling.
