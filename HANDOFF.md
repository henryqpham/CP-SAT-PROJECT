# HANDOFF — 2026-07-07

## The owner's direction (read this first)

Two verbatim quotes set the roadmap:

1. *"the key thing I really want from this app is the functionality, and simplicity — right
   now it's infeasible and I don't know what to do."* → the infeasibility TRIAGE view.
2. After importing testdoc.docx and getting a meaningless 08:00 pile-up: *"the program should
   have a clear understanding of the documentation when the LLM reads through it … good context
   understanding and applied logical thinking when building out the timeline with CP-SAT."*
   → the LLM-first document reader (the current build).

Judge every change against: **would a mission manager know what to do next without a guide?**

## Repo state

- Committed `45b6eb1`: duration-parse hardening (minutes, cap/cadence vetoes, labeled-first),
  the empty-doc near-miss-id gate ("did you mean [SH-801]?"), load options.
- Committed `ccef0e2` / `4756c95`: UI polish + the six-track build (two-genre extractor, fill,
  doc-chat, assistant, permanent suite).
- UNCOMMITTED (this diff): the **doc-parse foundation** package (below), built from a verified
  5-layer diagnosis of why testdoc.docx imported as an unreadable plan (all 37 activities at
  08:00 D1, health "4h/168h (2%)", lanes named `srme`).
- Verify: `python run_tests.py` must be green (backend pytest + jsdom UI; count grows with every
  feature — trust the run output, not a hand-written number here). After code edits run
  `graphify update .` (see CLAUDE.md).

## This diff: the doc-parse foundation (all tested)

- **solver.py** — multi-day plans get a tie-break objective (minimize sum of starts; keep-term
  still dominates when optionals exist). Before: multi-day-no-conditionals had NO objective at
  all → arbitrary first-feasible layout. Tests: `test_multiday_tiebreak_*` in tests/test_solver.py.
- **app.js renderHealth** — the capacity gauge measures **booked work** (sum of scheduled
  minutes), not wall-clock span. 52h of parallel work used to read "4h (2%)". Test:
  tests/ui/health-strip.test.mjs.
- **ingest.py `_heading_level`** — bold punctuation-only lines (fake `-----` rules) no longer
  count as headings; they used to wipe the breadcrumb and appendix titles. Test in test_ingest.py.
- **extract_det.py / extract.py** — duplicate requirement ids are counted and flagged
  (`coverage.duplicate_ids` + warning; testdoc defines 12 ids twice — was fully silent);
  `_OWNER`/resource regexes accept `/` `&` and via/using/through connectors ("Owner: MAR/SAIC",
  "Conducted via CEM"); NEW `_DEP_BEFORE` catches "performed before / prior to [X]" as a
  reversed precedence edge; NEW `parse_glossary` reads "SRME — Long Name" lines under
  acronym/glossary headings into `Scenario.section_labels` (display-only IR field, models.py).
- **app.js review modal** — duplicate-id flag; "Needs your review" section renders the
  previously write-only `cross_references.ambiguous` channel with one-click add-as-precedence
  in EITHER direction (never auto-added). Timeline lanes show glossary labels (raw id on hover).
  Tests: tests/ui/review-modal.test.mjs, tests/ui/lane-labels.test.mjs, test_extract_duplicates.py,
  test_extract_glossary.py.

## BUILT this diff: the LLM-first document reader (round 1)

The pipeline inversion the owner asked for ("the program should have a clear understanding of
the documentation") — the local model as primary READER, the deterministic rules as the
authoritative cross-check:

- **`extract_llm.py`** — `chunk_blocks` (overlapping word-budget windows, NO headers/ids/layout
  assumed) → per-chunk typed notes from the local model (activities with duration/resource/
  recurrence/optionality, relations BY NAME: after/before/during/not_concurrent/min_gap, plus
  an `unmodeled` list; every fact carries its quoted evidence sentence) → `consolidate` resolves
  names against the extraction (id mention > exact label > token-Jaccard ≥ 0.6), maps relations
  onto IR types, DROPS anything the deterministic pass already captured, and parks the rest in
  `couldnt_model` (e.g. per-cycle recurrence — no IR primitive yet). Per-call Ollama timeout
  (`DEEP_READ_TIMEOUT`), chunk cap, Ollama-down = one clear error, not one per chunk.
- **`/deep_read`** (app.py) — runs the reader over doc_chat's stored blocks (same-session
  import required); 503 with the actionable message when Ollama is off.
- **Review modal** — a "🧠 Deep read (local model)" button with a live seconds counter; the
  proposals render as CHECKBOXES with their evidence quotes; couldn't-model items are listed
  read-only. `confirmExtractLoad` merges only the CHECKED items and fills missing constraint
  ids. The model never writes into the plan directly.
- Tests: tests/test_extract_llm.py (chunker, read errors, consolidation, IR round-trip),
  /deep_read route tests in test_routes.py, tests/ui/deep-read.test.mjs (button → proposals →
  selective load).

Round-2 ideas (not built): run the reader automatically for docs where the det pass finds
little; entity-dedup across proposals with one extra model call; new IR primitives so
`couldnt_model` shrinks (per-cycle recurrence, event anchors); a headerless testdoc variant
as a fixture; model-vs-rules disagreement badges (currently model restatements are dropped,
not compared).

## Still queued (owner-endorsed, after the reader)

- The infeasibility TRIAGE view (`/triage`: gather ALL conflicts, fix-it list with the right
  action per row — data/soft/hard). Spec details in git history of this file (2026-07-06).
- Live-solve time limit + honest FEASIBLE status; stale-response guard on /solve.
- Schedule export (CSV / print) — "the journey has no exit."

## Test documents (what each one proves)

- `testdata/sample_vehicle_requirements.docx` — spec genre, 29/29, planted VR-512 self-loop
  (the VR-1012 "deadline infeasibility" never actually binds — 153-day derived runway).
- `testdata/artemis_3day_schedule.docx` — schedule genre; deliberately contradicts itself by
  10 min; the self-check must flag exactly 2 violations.
- `testdoc.docx` (repo root, committed) — the "messy real doc" fixture: 49 requirement blocks
  but 12 duplicate ids, bold-divider fake headings, `Owner: MAR/SAIC`, "Conducted via CEM",
  an acronym appendix, and per-cycle phrasing the IR can't hold yet. Exercises every foundation
  fix in this diff. TODO: move into testdata/ with an end-to-end ingest test.

## Known gaps (pre-existing, documented)

- `time_window`/`conditional` silently don't bind on a `recurs_daily` activity (bare-id match).
- `solve()` labels every solve "OPTIMAL"; live `/solve` has no time limit (`/fill` capped at 10s).
- Recurrence beyond strict-daily ("per operational cycle/block") has no IR primitive — the
  reader must park those in "couldn't model" rather than faking recurs_daily.
- The assistant's plan summary gives id/type/label per constraint, not full fields, and drops
  activity labels (breaks on doc-imported plans).

## Quick browser pass (~3 min)

`flask --app app run --debug`, hard-refresh (stale-cache trap):
1. Import `testdoc.docx` → review modal shows the duplicate-ids flag, "Needs your review"
   cross-references (if any), glossary-labeled sections in the table → load → lanes show long
   names, health strip says "work NNh / 168h".
2. Import the artemis schedule doc → self-check flags jump to rows → loads OPTIMAL, day rhythm.
3. ⤒ Fill window on the lake example → blue FILL PREVIEW capsule, × returns to live.
4. 💬 Ask the doc → cited answer; kill Ollama → ⚠ error bubble with Retry, app fine.
5. 🤖 Assistant → "add a 30 minute swim" → changes card with ↶ Undo; Ctrl+Z restores.
