# HANDOFF — 2026-07-01/02 build session

Everything below is UNCOMMITTED work in the working tree. The suite is green:
`python run_tests.py` → 188 backend tests + 6 jsdom UI tests. Owner reviews and commits
(never commit for them).

## Final QA review (done)

A 4-dimension multi-agent review (correctness, upload-path security, IR-contract drift,
conventions) ran over the full diff; every finding was adversarially verified, and ALL
confirmed ones were fixed + pinned with regression tests:

- **HIGH (reproduced, fixed): fill mode broke conditional duration rules.** `solve_fill`
  minted a fresh presence var per occurrence, orphaning a duration rule's trigger bool —
  filling the lake example returned a 240-min sail WITH kiteboard scheduled. Fixed by reusing
  the pre-created var (same pattern as `solve()`); `test_fill_respects_conditional_duration_rules`.
- **Fixed: schedule extraction crashed (500) on a row with no readable duration** ("TBD"
  start, no Duration column) — the skipped roster group was still dereferenced by the coverage
  rows + bullet-rule expansion. Now degrades with warnings; test added.
- **Fixed: fill report** — a section whose activities were ALL left out no longer vanishes
  (shows used 0), and the "(no section)" bucket counts a merged union so parallel activities
  can't show >100% / negative left.
- **Fixed: stated operating hours with no resolvable resource** no longer fall back to a
  plan-wide `section="all"` curfew — skipped + warned (mirrors the budget guard).
- **Fixed: unsatisfiable bounds on a dropped optional activity** (impossible time_window /
  oversized time_lag) used to sink the whole fill INFEASIBLE; every relative bound is now
  gated on the endpoints' presence literals (mandatory activities unchanged — plain adds).
- **Fixed (hostile/broken-doc hardening in extract_sched):** "Day N" numbering is normalized
  to the doc's own base (a Day-0 doc works) and capped at 366 days (clean 400 beyond);
  the pairwise buffer rule is capped at 2000 pairs (warn-but-solve beyond); start==end rows
  are zero-length markers, not 24h intervals; a name repeated inside one day keeps one id.
- **Fixed: IR now requires duration ≥ 1** (models.py `Field(ge=1)`) so an LLM-chosen 0/negative
  duration bounces off validation instead of wedging CP-SAT; README IR section updated.
- **Fixed: smaller hardening** — malformed clock tokens skip a working_window instead of
  failing validation later; doc-chat indexing capped (DOC_CHAT_MAX_BLOCKS, default 5000) with
  batched embed calls; assistant prompt flattens/caps doc-derived labels (injection surface).

## What was built (all verified)

### Track 0 — permanent test suite
- `tests/` (pytest) + `tests/ui/` (jsdom via `node --test`) + `run_tests.py` (one command) +
  `pytest.ini`. `pytest` added to requirements.txt.
- Covers: models/IR validation, every solver constraint type + recurring pairing (`occ_pairs`,
  `day_shift`), the 3 example smokes + the CLAUDE.md lake smoke, explain/relax, ingest (in-memory
  docx builders, zip-bomb guard), the sample-spec extraction (29/29 pinned), Flask routes
  (happy + error paths), and per-track tests added below.
- UI harness: `tests/ui/harness.mjs` loads index.html + app.js in jsdom with a mocked fetch.
  One-time setup: `npm install` inside tests/ui (node_modules is gitignored there).
- The "delete test scaffolding" memory was amended: the suite is permanent; scratch probes still
  get deleted.

### Track 1 — schedule-genre extractor (the artemis doc)
- `extract_sched.py` (new, fully deterministic — no LLM): rule bullets → constraints
  (adjacency "immediately before/after", wake rules with cross-midnight `day_shift`, meal-start
  chains, ≥Nm-from-meals separations, awake target/absolute-max span caps with priority 3/1,
  pairwise transition buffers, no_overlap all); day tables → the roster (same-duration-every-day →
  one `recurs_daily` activity; day-varying → per-day variants with `days=[d]`; bullet-stated
  durations WIN over table values, warned). Time-of-day phrases → `daily_window`
  (first-half-of-day, mid-morning, …). NO pinned `time_window` per row — the tables are treated
  as the doc's worked example.
- `ingest.py`: table cells now carry `table`/`row`/`col`, paragraphs carry `is_bullet` (additive).
- `extract.py`: `detect_genre()` — [VR-xxx] backbone → spec; Start/End/Activity tables → schedule.
- **Doc self-check** (`check_against_doc`): the doc's own timetable is verified against every
  extracted rule; violations go into coverage + the review modal.
- **Finding worth knowing:** `testdata/artemis_3day_schedule.docx` contradicts ITSELF — day-2
  sleep (22:00 + 8h30m = 06:30 day 3) overlaps day-3 post-sleep (06:20) by 10 min. The self-check
  catches exactly those 2 violations (wake adjacency + no_overlap); everything else passes.
  `tests/test_extract_sched.py` pins this. If the owner fixes the docx, update that test to
  expect 0 violations.
- Verified: extraction → 17 activities / 76 constraints / 10/10 bullets modeled; solve on the
  3-day horizon → OPTIMAL; every row + bullet accounted; results flow through the same review
  modal (schedule-genre chips + self-check flags added).
- The doc file is still UNTRACKED — commit it with this track (the oracle test needs it).

### Track 2 — spec extractor finished
- `extract_det.py`: `parse_rationale` ("Rationale: …" lines), `working_windows`
  ("between 8:00 and 17:30" + an operations word, sentence-scoped), `section_budgets`
  ("total … shall not exceed N hours" — requires an aggregate word so per-activity caps don't
  misfire), `overlap_edges` ("during [VR-x]" → contains; "concurrent/in parallel with [VR-x]" →
  overlaps). Priority graded from the CONTAINING SENTENCE (so "should … during" = P3 even when
  the next sentence says "shall").
- `extract.py` merges them with section = the requirement's resource, rationale attached to every
  derived constraint (precedence + deadlines too), extraction report counts them.
- Review modal shows rationale under each constraint's source ("why: …") + a rationales chip.
- Regression pinned: the sample spec still extracts 29/29 with exactly 35 constraints, all 35 now
  carrying real rationales; zero false positives from the new patterns.
- **Finding worth knowing:** the "planted VR-1012 deadline-chain infeasibility" does NOT actually
  bind — the derived project start gives the chain 153 days of runway, so after disabling the
  VR-512 self-loop the plan solves OPTIMAL. The suite pins reality (self-loop = the only conflict).
  If a second planted infeasibility is wanted, the sample doc (or the start-date lead heuristic)
  needs changing — owner's call.

### Track 3 — fill / utilization objective
- `solver.py`: `solve_fill()` — a SEPARATE solve path (the live keep−tidy objective in `solve()`
  is untouched; shared, behavior-neutral helpers were extracted and the full solver test file
  guards that). Every activity becomes optional; objective = maximize scheduled minutes; 10s time
  limit (`FILL_TIME_LIMIT_SECONDS`). Returns per-section utilization (`fill.sections[name] =
  {capacity, used, pct, left}`), `fill.overall` (+ `overflow` = minutes that didn't fit) and
  `left_out` ids.
- `POST /fill` + a topbar "⤒ Fill window" button; the health bar shows a FILL pill, per-section
  `%` + left, and a "didn't fit" note; the toast lists what was left out. Any normal solve clears
  the fill view.

### Track 4 — Ask the doc (the only RAG feature)
- `doc_chat.py`: /extract keeps the ingested blocks in process memory; first question lazily
  embeds them (`OLLAMA_EMBED_MODEL`, default nomic-embed-text — pulled and live-verified);
  cosine top-k with DEDUPE of repeated cell texts; the chat model answers from numbered excerpts
  and must cite [n]; the retrieved blocks are always returned as `sources`.
- `POST /doc_chat`: 400 (no question / no doc yet), 503 (Ollama down, same shape as /parse),
  502 (model garbage). UI: "💬 Ask the doc" modal, sources listed under every answer.
- Live-verified against the artemis doc: "How long is sleep and what must happen immediately
  before it?" → "8h15m … 45m pre-sleep right before", correctly cited.

### Track 5 — plan assistant (tool-calling, no LangChain)
- `assistant.py`: Ollama NATIVE tool-calling loop (max 8 rounds) over typed tools:
  add_activity / remove_activity / set_duration / add_constraint / toggle_constraint / solve /
  explain_infeasible. Every mutation is applied to a copy and re-validated through the Pydantic
  IR — an invalid change bounces back to the model as a tool error, never reaches the plan.
  Returns `{reply, scenario, changed, actions}`.
- `POST /assist` (503 when Ollama is down). UI: "🤖 Assistant" modal; an applied edit goes through
  `flushHistory()` → replace scenario → `render()` (same undo/redo + live re-solve as a manual
  edit) and the panel lists exactly what changed. Undo verified in a jsdom test.
- Live-verified with granite4.1:8b: "Add a 45 minute swim in the Lake section, then check the
  plan still fits" → tool calls add_activity + solve, correct scenario back, sensible reply.

### Docs
- README: Status, endpoints (/fill, /doc_chat, /assist, genre auto-detect), mermaid, structure
  tree, test command, local-model setup. CLAUDE.md: commands + structure + testing section.
  `.env.example`: OLLAMA_EMBED_MODEL added.

## Known gaps / candid notes (not regressions — pre-existing or by design)
- `time_window` (and `conditional`) still match a bare activity id only — on a `recurs_daily`
  activity they silently don't bind (documented IR semantics in the README, but it LOOKS like the
  old silent-drop bug; a warning surface would help).
- `solve()` labels a FEASIBLE (time-limited, non-proven-optimal) result "OPTIMAL". `solve_fill()`
  reports the true status.
- The live `/solve` has NO time limit (pre-existing). A pathological plan could hang the debounced
  loop; `/fill` is bounded (10s).
- The assistant's plan summary sent to the model omits constraint details beyond id/type/label —
  granite sometimes has to ask or guess about exact fields.
- Fill-mode "capacity" counts each section as one serial resource (horizon minutes each). The
  "(no section)" bucket reports merged busy time (never >100%), but its "capacity" is still one
  horizon even though unsectioned activities may run in parallel — a display convention, not math.

## Suggested commit chunks (in order)
1. **Test suite** — tests/ (backend), tests/ui/ (+ package.json, .gitignore), run_tests.py,
   pytest.ini, requirements.txt, conftest; CLAUDE.md + README test sections; the ingest 400 fix
   (ingest.py Document→ValueError + the 2 route/ingest tests).
2. **Schedule-genre extractor** — extract_sched.py, ingest.py (block metadata), extract.py
   (genre dispatch), app.js/style.css review-modal additions, testdata/artemis_3day_schedule.docx,
   tests/test_extract_sched.py.
3. **Spec extractor finish** — extract_det.py + extract.py (windows/budgets/overlaps/rationale),
   app.js rationale display, tests/test_extract_spec_types.py.
4. **Fill mode** — solver.py (helpers + solve_fill), app.py /fill, index.html + app.js + style.css
   fill UI, tests/test_fill.py, README.
5. **Ask the doc** — doc_chat.py, app.py (/doc_chat + extract indexing), chat modal UI,
   tests/test_doc_chat.py, .env.example.
6. **Assistant** — assistant.py, app.py /assist, assistant modal UI + history integration,
   tests/test_assistant.py, tests/ui/fill-and-chat.test.mjs.
(Or one commit per track exactly as the tracks above; each chunk leaves the suite green.)

## Browser pass — what headless tests can't see (5–10 min)
Run `flask --app app run --debug`, hard-refresh (Ctrl+Shift+R — stale-cache trap), then:
1. **Import the artemis doc** (📄 Import doc → testdata/artemis_3day_schedule.docx). The review
   modal should show: "table rows 39", "rules modeled 10/10", a RED self-check flag block naming
   the day-3 sleep overlap, and constraints whose detail column reads sensibly (time_lag /
   min_separation one-liners, not raw type names). Load it → timeline should draw 3 days,
   activities colored by kind (sleep/meals/exercise), status OPTIMAL.
2. **Import the sample spec** (testdata/sample_vehicle_requirements.docx). Review modal: chips
   including "rationales 29", P1/P3/P5 badges have distinct colors, each constraint shows
   "why: …" under its source. Load → INFEASIBLE banner → "Which rules conflict?" names the
   VR-512 self-loop → disable it → plan turns OPTIMAL.
3. **Fill window** on the lake example: click ⤒ Fill window — health bar gains a FILL pill +
   per-section % chips; toast says everything fits. Then shrink the horizon (click the Horizon
   chip, set ~3h) and Fill again — toast lists left-out activities, health shows "didn't fit".
   Check the FILL chips disappear after the next normal edit/solve.
4. **Ask the doc** (after step 1): ask "how long is sleep?" — answer bubble with [n] citations and
   a Sources list under it; sources mention the Global Constraints bullet. Kill Ollama
   (`taskkill /im ollama.exe` or quit the tray app) and ask again — a clean red error bubble, app
   still fine (restart Ollama after).
5. **Assistant** on the lake plan: "add a 30 minute swim at the lake" — reply bubble + "Changes:"
   list, roster gains swim, timeline re-solves live; Ctrl+Z removes it; Ctrl+Shift+Z brings it
   back. Try "delete the swim" too.
6. **Modals & keys**: Esc closes the two new chat modals; Enter sends; backdrop click closes;
   focus lands in the input when opening.
7. **Visual sanity**: chat bubbles readable in the dark theme (user right / bot left), fill chips
   don't overflow the health bar on a narrow window, the new topbar button doesn't wrap the
   toolbar.

## If something regressed
The suite pins everything: `python run_tests.py`. The three classic tripwires (stale-cache
SEND_FILE_MAX_AGE_DEFAULT, renderRoster box.append, .lib-row fixed actions column) were verified
untouched in the final review.
