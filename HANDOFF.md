# HANDOFF — state as of 2026-07-06

The six-track build (test suite, two-genre .docx extractor, fill mode, Ask-the-doc,
assistant) is COMMITTED as `4756c95`, reviewed by a multi-agent QA pass with every
confirmed finding fixed and regression-tested. Suite: `python run_tests.py` →
188 backend + 6 jsdom UI tests, all green.

## The current uncommitted diff (UI polish + cleanup, 2026-07-06)

UI/UX pass over the new surfaces only (research-driven; before/after screenshots
verified). No solver/IR/backend changes.

- **Review modal (was broken):** the flex body squashed the tables — the artemis
  activities table showed 0 of 17 rows and nothing scrolled. Fixed (`flex-shrink: 0`
  + per-table scroll with sticky headers). Confirm button now states what it commits
  ("Load 17 activities + 76 constraints"); self-check flags are clickable "— show me"
  jumps to the offending row; initial focus goes to the title, not the confirm button.
- **Fill preview reads as a mode:** accent-blue bordered FILL PREVIEW capsule (no
  longer FEASIBLE-green), "unsectioned" instead of "(no section)", ⚠ on "didn't fit",
  × dismiss that returns to the live solve.
- **Chat panels:** real **bold** rendering + clickable [n] citation chips that flash
  their source line; sources collapse behind "Sources (n)"; error bubbles say
  "⚠ Error —" with a ↻ Retry button; animated dots + elapsed seconds while the local
  model works; Send disabled while pending; capability intro + example-prompt chips
  on first open; "local model · ~10–30 s" hint; visible ↶ Undo button on assistant
  changes cards.
- **A11y:** focus trap + focus return on the three new modals, `aria-labelledby`,
  `role="log"` chat logs, `role="status"` health strip, keyboard-scrollable labeled
  table regions.
- **Cleanup:** deleted three unreferenced root leftovers (`artemislogo2.png`,
  `thumb-1920-1408041.jpg`, `grocery-store-library.json` — all recoverable from git
  history); .gitignore now covers `graphify-out/` (generated; rebuild with
  `graphify update .`), `.pytest_cache/`, `node_modules/`, and explicitly un-ignores
  the four tracked docs. Code sweep found zero TODO/FIXME/console.log markers and
  zero unused imports — no comment surgery was needed.

## Known gaps / candid notes (pre-existing or by design)

- `time_window` / `conditional` match a bare activity id only — on a `recurs_daily`
  activity they silently don't bind (documented IR semantics; a warning surface would help).
- `solve()` labels a FEASIBLE (time-limited) result "OPTIMAL"; `solve_fill()` reports
  the true status. The live `/solve` has no time limit; `/fill` is capped at 10s.
- The artemis test doc contradicts itself (day-2 sleep vs day-3 post-sleep by 10 min);
  the extractor's self-check catches exactly that and the oracle test pins it. If the
  doc is regenerated consistent, update `tests/test_extract_sched.py` to expect 0 violations.
- The sample spec's "planted VR-1012 deadline infeasibility" never binds (153-day
  derived runway) — only the VR-512 self-loop does; tests pin reality.
- The assistant's plan summary gives the model id/type/label per constraint, not full
  fields — a small local model sometimes guesses at details.

## Quick browser pass (~3 min)

`flask --app app run --debug`, hard-refresh (stale-cache trap), then:
1. Import `testdata/artemis_3day_schedule.docx` → review modal scrolls, tables full,
   amber self-check flags jump to rows, "Load 17 activities + 76 constraints" → OPTIMAL timeline.
2. ⤒ Fill window on the lake example → blue FILL PREVIEW capsule in the health bar;
   × returns to live view.
3. 💬 Ask the doc → suggestion chips work; an answer shows bold text + clickable [n]
   cites + collapsed Sources. Kill Ollama → ⚠ error bubble with Retry, app fine.
4. 🤖 Assistant → "add a 30 minute swim" → changes card with ↶ Undo button; Undo restores.
