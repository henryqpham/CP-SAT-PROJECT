# HANDOFF — 2026-07-06

## The owner's direction (read this first)

Verbatim, after importing a test doc: *"the key thing I really want from this app is the
functionality, and simplicity — right now it's infeasible and I don't know what to do."*

That sentence is the whole roadmap. The engine is correct and tested; the gap is that when a
plan doesn't fit, the app hands the user mechanisms (explain / relax / inspector / priorities)
instead of walking them to the fix. Judge every next change against: **would a mission manager
know what to do next without a guide?**

## Repo state

- Committed `4756c95`: the six-track build — permanent test suite, two-genre .docx extractor
  (spec + schedule, genre auto-detect, doc self-check), fill mode (`/fill`), Ask-the-doc RAG
  (`/doc_chat`), plan assistant (`/assist`), all QA-reviewed with fixes regression-tested.
- UNCOMMITTED (this diff): UI/UX polish of those surfaces (research-driven; review-modal scroll
  bug fix, fill-preview capsule, chat citations/retry/suggestions, a11y), repo cleanup
  (3 unreferenced files deleted, .gitignore organized), and the **"first 60 seconds after
  import" package** — imported labels shown instead of ids, "Plan over N days" + day-hours
  checkbox in the review modal, auto-fit zoom, honest empty-health copy.
- Verify everything: `python run_tests.py` → 188 backend + 6 jsdom UI tests, green.
  After code edits run `graphify update .` (see CLAUDE.md).

## TOP PRIORITY next build: the infeasibility TRIAGE view

Today's session is the spec. The owner imported a synthetic Artemis II doc with 4 independent
problems; the app surfaced them one at a time, worst experience first:
- "Which rules conflict?" named ONE rule (an impossible 3h-inside-1h overlap).
- Auto-relax stopped cold on an all-P1 conflict (`AR-235 total ≤ 720 min`) with advice
  ("lower priority / turn off") that was WRONG for the real cause — the extractor had misread
  the activity's duration (12h cap read as duration), so the fix was editing one number.
- The P1↔P1 dependency loop needed Manage-constraints archaeology to find and disable.

Build instead: when a solve is INFEASIBLE, gather ALL problems and present a fix-it list.
- Backend: a `/triage` endpoint. Loop: explain → record the minimal conflict → temporarily
  disable its most-droppable member (like relax_by_priority, but keep going past hard
  conflicts by disabling one member to reveal the next problem) → repeat until feasible.
  Return every conflict found, tagged: `data` (a section_budget whose section's FIXED
  durations already exceed the cap — computable directly), `soft` (has a priority>1 member),
  `hard` (all P1). O(n²) solves — on-demand only, like /explain.
- UI: replace the two banner buttons' flow with a triage panel (reuse .explain-row styles):
  one row per problem with the RIGHT action each — `data` → "Edit ar_235 (12h exceeds its own
  12h cap)" opening the inspector; `soft` → "Relax (drops this ≤P3 rule)"; `hard` → show both
  rules + sources, "Disable this one / that one". Progress feel: "Problem 2 of 4".
- Cheap companion: an "Ask the assistant why" button on the INFEASIBLE banner — assistant.py
  already has the explain_infeasible tool and speaks plainly.

## Second quick win: stop the duration misreads at the source

Bitten twice in demos (GBORD, then AR-235). In `extract_det.py`, `_DURATION` reads
"N hours/days/weeks" anywhere in the body, so it grabs caps ("shall not exceed 10 hours") and
cadences ("every 7 days"), and can't read "30 minutes" at all. Fix: add `minute|min` to the
unit list, prefer a match after "Estimated duration:" when present, and skip matches preceded
by "not exceed / no more than / every / within". Add regression tests (the misread cases are
described in tests + this file). This alone removes the nastiest triage case.

## Test documents (what each one proves)

- `testdata/sample_vehicle_requirements.docx` — spec genre, 29/29, planted VR-512 self-loop
  (the VR-1012 "deadline infeasibility" never actually binds — 153-day derived runway).
- `testdata/artemis_3day_schedule.docx` — schedule genre; deliberately contradicts itself by
  10 min (day-2 sleep vs day-3 post-sleep); the self-check must flag exactly 2 violations.
- The owner's ChatGPT "Artemis II — Mission Operations Requirements" doc (not in testdata yet;
  worth committing): 23 reqs, exercises everything, and carries 4 real traps — AR-235's
  "30 minutes" → misread as 12h (busts its own budget), AR-345 typo (not-extracted tripwire),
  two impossible "during" rules (3h-in-1h, 4h-in-2h, P3), and a planted P1↔P1 loop
  (AR-310↔AR-315). Fastest manual path to green: edit ar_235 duration → 30; auto-relax
  (drops the two P3 overlaps); disable one loop leg; OPTIMAL.

## Known gaps (pre-existing, documented)

- `time_window`/`conditional` silently don't bind on a `recurs_daily` activity (bare-id match).
- `solve()` labels a time-limited FEASIBLE as "OPTIMAL"; live `/solve` has no time limit
  (`/fill` is capped at 10s).
- A spec doc's derived horizon can be ~5 weeks for ~2 days of work (30-day deadline lead in
  `derive_dates`) — the "Plan over N days" load option covers it, but triage should EXPLAIN it.
- The assistant's plan summary gives id/type/label per constraint, not full fields.

## Quick browser pass (~3 min)

`flask --app app run --debug`, hard-refresh (stale-cache trap):
1. Import the artemis schedule doc → review modal scrolls, amber self-check flags jump to
   rows, confirm button states counts → loads OPTIMAL, labeled, day-rhythm timeline.
2. Import a spec doc → Load options row (days + day-hours checkbox) → loads with real names,
   work inside 08:00–20:00, auto-fitted.
3. ⤒ Fill window on the lake example → blue FILL PREVIEW capsule, × returns to live.
4. 💬 Ask the doc → suggestion chips, cited answer, collapsed Sources; kill Ollama → ⚠ error
   bubble with Retry, app fine.
5. 🤖 Assistant → "add a 30 minute swim" → changes card with ↶ Undo; Ctrl+Z restores.
