# CLAUDE.md

Natural-language scheduling optimizer: a sentence becomes editable JSON constraints, CP-SAT
solves them, a dashboard shows the result. One local Flask app, Python only. See README.md for
the architecture and data flow.

## Commands

- Install deps: `pip install -r requirements.txt`
- Pull the local parse model (one-time): `ollama pull qwen2.5:7b` (install Ollama from ollama.com first)
- Run: `flask --app app run --debug` — dashboard at http://localhost:5000
- Use without the LLM: GET `/example` (the demo IR), or POST `examples/lake.json` to `/solve`

## Structure

- `app.py` — Flask routes: `/` (dashboard), `/parse` (Ollama), `/solve` (CP-SAT), `/example` (demo IR)
- `models.py` — Pydantic IR; the JSON contract shared by `/parse`, the dashboard, and `/solve`
- `parse.py` — a local Ollama model turns a sentence into a validated `Scenario`
- `solver.py` — turns a `Scenario` into a CP-SAT model and solves it
- `templates/index.html`, `static/app.js`, `static/style.css` — the vanilla-JS dashboard
- `examples/lake.json` — a hand-written IR for testing `/solve`

## Conventions

- IMPORTANT: Do NOT `git commit` on your own — make the edits, then let the owner review and
  commit. Go through the owner first, and also before any destructive git op (`reset`,
  `revert`, `checkout --`, `push --force`).
- Before changing code, read README.md, then the file(s) you are about to change.
- When you change a module, a command, the folder layout, or the IR in `models.py`, update
  README.md and its mermaid diagram in the same change.
- Add a new constraint type in `models.py` first, then handle it in `solver.py` and render it
  in `static/app.js` — the IR is the single contract; keep the three in sync.
- Validate the parsed constraints, not just the solve result: an LLM can return a valid-looking
  schedule while dropping a rule, so keep each constraint's `source` phrase and show it.
- Parsing runs on a LOCAL Ollama model by design (privacy: no data leaves the machine) — no
  cloud LLM calls, no API keys. Don't reintroduce a hosted API. Override the model with the
  `OLLAMA_MODEL` env var; read config from the environment, never hardcode it.
- New Python dependencies go in `requirements.txt` in the same change that imports them.

## Testing

- After a change, run `examples/lake.json` through `/solve`: it must return `OPTIMAL`.
- Set `drive_to_lake.earliest` to `21:00` while `drive_home.latest_end` is `22:00`; `/solve`
  must return `INFEASIBLE`. Use this as the smoke test for constraint handling.
