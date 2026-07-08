// Dashboard: add activities + rules by hand -> edit the cards -> /solve -> draw the timeline.
let scenario = { activities: [], constraints: [] };
// The last schedule that solved. If a later edit makes things INFEASIBLE we show this one
// (dimmed) instead of an empty timeline.
let lastFeasibleSchedule = null;
// Section names the user has clicked shut in the timeline. Sections start open.
const collapsed = new Set();
// The schedule currently drawn, so we can redraw (e.g. when a section is toggled) without re-solving.
let shownSchedule = null;
let shownStale = false;
// Bumped on every solve result; lets the async "why infeasible" explainer bail if a newer solve
// landed while it was awaiting /explain (so a stale explanation never renders over a changed plan).
let resultSeq = 0;
// The id of the activity the user clicked in the timeline. The Inspector panel edits this one.
let selectedId = null;
// Timeline view: false = Lanes (per-section), true = Overview (lanes collapsed to summary bars).
let overview = false;
// Timeline grouping field: "section" (default), "type", or "assignee" — each reads a real field on
// the activity (nothing derived from id naming). Presentation only — changing it redraws, never re-solves.
let groupMode = "section";
// Mission-elapsed cursor position, in absolute minutes. A planned plan has no live "now", so this is
// a draggable marker the user parks at a moment of interest. null = sit at the plan's start.
let cursorMin = null;
// Timeline zoom (presentation only — never re-solves). X = time-axis width multiple (1 = fit the
// panel; higher widens the chart and the canvas scrolls). Y = row-height multiple.
let zoomX = 1;
let zoomY = 1;
// Saved plans ("missions"): each tab is { name, scenario }. The active tab's scenario is the live one.
let tabs = [];
let activeTab = 0;
const TABS_KEY = "planner.tabs.v1";
const clone = (x) => JSON.parse(JSON.stringify(x));
// Undo/redo: snapshots of the scenario as JSON strings. histPresent is the last recorded state;
// rapid edits are coalesced (debounced) into one entry so typing isn't one-undo-per-keystroke.
let histUndo = [];
let histRedo = [];
let histPresent = "null";
let histTimer = null;

const $ = (id) => document.getElementById(id);
const DAY = 24 * 60;
// The horizon (planning window, minutes) the solver actually used on the last solve. Drives
// whether the timeline draws a single day or a multi-day view. Defaults to one day.
let solvedHorizon = DAY;
// Activity types -> bar color + legend label, loaded from /static/library.json at startup.
// An activity with no type (or a type the library doesn't define) falls back to the neutral
// bar color from the stylesheet — there is no color data hardcoded here.
let TYPES = {};
// User-defined category styling (color + icon), persisted in localStorage and merged onto TYPES.
let customTypes = {};
const TYPES_KEY = "planner.types.v1";
// Recently-added templates (labels, most-recent first) — a quick strip at the top of the Library.
let recents = [];
const RECENTS_KEY = "planner.recents.v1";
// An occurrence id like "lunch#d2" maps back to its source activity "lunch" — recurs_daily expands
// one activity into per-day occurrences, and the source carries the section/type/color.
const sourceId = (id) => String(id).split("#")[0];
const findActivity = (id) => scenario.activities.find((x) => x.id === sourceId(id));
const colorFor = (id) => {
  const a = findActivity(id);
  if (a && a.type && TYPES[a.type]) return TYPES[a.type].color;
  return "var(--bar)";
};

// ---- timeline derivations: crew / kind / lane / label --------------------
// All four are DISPLAY-only — they read the id, section, and type already in the data; they never
// change the scenario or the solve. The kind map (icon + match tokens) and the abbreviation map
// live in library.json (KINDS / ABBREV), not here, so adding a kind is a data edit, not a JS edit.
let KINDS = {};   // kind key -> { label, icon, match:[tokens] }; color comes from CSS var --kind-<key>
let ABBREV = {};  // lower-case id token -> pretty replacement (e.g. "dpc" -> "Daily Planning Conf")

// kindOf(item) -> "sleep|meal|exercise|eva|comms|ops" (default "ops"). The activity's type wins if
// it names a kind; otherwise the id's tokens decide. We scan tokens LEFT-TO-RIGHT and take the first
// kind any token matches, so a leading namespace wins: "comms_eva_conf" reads as comms, not eva.
function kindOf(item) {
  const a = findActivity(item.id);
  const tokens = [(a && a.type) || "", ...sourceId(item.id).split("_")]
    .map((t) => t.toLowerCase()).filter(Boolean);
  for (const tok of tokens) {
    for (const key in KINDS) if ((KINDS[key].match || []).includes(tok)) return key;
  }
  return "ops";
}

// laneOf(item, mode) -> the swimlane this item belongs in, for the chosen group-by field:
//   "assignee" -> the activity's assignee (a worker/friend/crew you typed), else "Unassigned"
//   "type"     -> the activity's type/category label, else "Untyped"
//   "section"  -> the section (default), else "Shared"
// Every dimension reads a real field on the activity — nothing is derived from id naming.
function laneOf(item, mode) {
  const a = findActivity(item.id);
  if (mode === "assignee") {
    const who = a && a.assignee && a.assignee.trim();
    return who || "Unassigned";
  } else if (mode === "type") {
    const t = a && a.type && a.type.trim();
    return (t && ((TYPES[t] && TYPES[t].label) || t)) || "Untyped";
  }
  const sec = (a && a.section && a.section.trim()) || "";
  return sec || "Shared";
}

// Human name for a section-mode lane: the doc's glossary label when the import found one
// ("srme" -> "Synthetic Resource Modeling Engine"), else the lane key itself.
function laneDisplay(lane) {
  if (groupMode === "section" && scenario.section_labels && scenario.section_labels[lane])
    return scenario.section_labels[lane];
  return lane;
}

const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

// prettify(id) -> a clean human label: drop the #dN occurrence, drop the crew letter (shown by the
// lane) and a trailing day-number, expand known acronyms, Title-Case the rest.
// e.g. "comms_pass_am#d1" -> "Comms Pass (AM)", "sleep_A_1" -> "Sleep", "orion_rcs_B_1" -> "Orion RCS".
function prettify(id) {
  let tokens = sourceId(id).split("_").filter((t) => !/^[A-D]$/.test(t)); // drop a lone crew letter
  if (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) tokens.pop(); // drop trailing day #
  const out = tokens.map((t) => ABBREV[t.toLowerCase()] || titleCase(t)).join(" ").trim();
  return out || sourceId(id);
}

// The display name for an activity: the imported label when one exists (a spec doc's
// ids are opaque, like "ar_200" — its label is "Recovery Beacon Test"), else the
// prettified id. Use this at every display site; prettify(id) is only the fallback.
function displayName(id) {
  const a = findActivity(id);
  return a && a.label ? a.label : prettify(id);
}

// The bar's icon for its kind (from library.json), used when a bar is too narrow for text.
const iconFor = (item) => (KINDS[kindOf(item)] || {}).icon || "";

// The bar's fill: an explicit user type-color wins (custom styling); otherwise the kind hue from the
// CSS palette (--kind-sleep/meal/…). No color literals here — the value is a CSS var name.
function barColor(item) {
  const a = findActivity(item.id);
  if (a && a.type && TYPES[a.type]) return TYPES[a.type].color;
  return `var(--kind-${kindOf(item)})`;
}

// ---- wiring -------------------------------------------------------------
addConstraintType("sequence", "Sequence (ordered)");
addConstraintType("working_window", "Working window (open hours)");
addConstraintType("section_budget", "Section budget (max minutes)");
addConstraintType("overlap", "Overlap (one runs during another)");
addConstraintType("time_lag", "Time lag (min/max gap between two)");
addConstraintType("min_separation", "Min separation (buffer apart)");

$("parse-btn").onclick = () =>
  withBusy($("parse-btn"), "Parsing…", async () => {
    const sentence = $("sentence").value.trim();
    if (!sentence) return;
    scenario = await post("/parse", { sentence });
    render();
  });

$("solve-btn").onclick = () => solveNow();
$("fill-btn").onclick = () => fillNow();
$("view-toggle").onclick = () => setView(!overview);
$("group-select").onchange = (e) => setGroupMode(e.target.value);

// Undo / redo + plan file actions (save / load / duplicate). State/presentation only — the solver
// still runs on the live plan; these just move snapshots around.
$("undo-btn").onclick = undo;
$("redo-btn").onclick = redo;
$("plan-duplicate").onclick = duplicateTab;
$("plan-export").onclick = exportPlan;
$("plan-import").onclick = () => $("plan-import-file").click();
$("plan-import-file").onchange = (e) => { if (e.target.files[0]) importPlan(e.target.files[0]); e.target.value = ""; };
// Import a .docx requirements document: extract -> REVIEW -> confirm-load. Nothing reaches the planner
// until the user approves it in the review popup (a rules/LLM pass can drop or mis-read a rule).
$("plan-import-doc").onclick = () => $("plan-import-doc-file").click();
$("plan-import-doc-file").onchange = (e) => { if (e.target.files[0]) runExtract(e.target.files[0]); e.target.value = ""; };
$("extract-close").onclick = closeExtractModal;
$("extract-cancel").onclick = closeExtractModal;
$("extract-load").onclick = confirmExtractLoad;
$("extract-modal").onclick = (e) => { if (e.target === $("extract-modal")) closeExtractModal(); }; // backdrop click

// ---- modal focus discipline (the doc-review + chat modals) ----------------
// Remember who opened the modal, put focus inside, give it back on close, and
// keep Tab cycling inside while open (the WAI-ARIA dialog pattern).
let modalReturnFocus = null;
function openDialog(modalId, focusId) {
  modalReturnFocus = document.activeElement;
  $(modalId).hidden = false;
  if (focusId && $(focusId)) $(focusId).focus();
}
function closeDialog(modalId) {
  $(modalId).hidden = true;
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}
function trapTab(modalId) {
  $(modalId).addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusables = [...$(modalId).querySelectorAll(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    )].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
trapTab("extract-modal");
trapTab("doc-chat-modal");
trapTab("assistant-modal");

// Ask the doc: Q&A over the last imported .docx (local RAG; answers cite the doc).
function openDocChat() {
  openDialog("doc-chat-modal", "doc-chat-input");
  seedChatIntro("doc-chat-log", "doc-chat-input", askDoc,
    "I answer questions about the last imported document, and every answer cites the passages it came from.",
    ["What are the main scheduling rules?",
     "Which activities happen every day?",
     "Are there any deadlines?"]);
}
const closeDocChat = () => closeDialog("doc-chat-modal");
$("doc-chat-open").onclick = openDocChat;
$("doc-chat-close").onclick = closeDocChat;
$("doc-chat-modal").onclick = (e) => { if (e.target === $("doc-chat-modal")) closeDocChat(); };
$("doc-chat-send").onclick = () => askDoc();
$("doc-chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") askDoc(); });

// Plan assistant: natural-language edits through typed tools (validated + undoable).
function openAssistant() {
  openDialog("assistant-modal", "assistant-input");
  seedChatIntro("assistant-log", "assistant-input", askAssistant,
    "I change this plan through checked steps — every edit is validated like a manual one, re-solves live, and Undo takes it back.",
    ["Add a 30 minute break after lunch",
     "Make exercise 45 minutes",
     "Why doesn't the plan fit?"]);
}
const closeAssistant = () => closeDialog("assistant-modal");
$("assistant-open").onclick = openAssistant;
$("assistant-close").onclick = closeAssistant;
$("assistant-modal").onclick = (e) => { if (e.target === $("assistant-modal")) closeAssistant(); };
$("assistant-send").onclick = () => askAssistant();
$("assistant-input").addEventListener("keydown", (e) => { if (e.key === "Enter") askAssistant(); });
// Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo — but only when NOT typing in a field,
// so a focused text input keeps its own native undo.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
});

// Timeline zoom sliders + "Fit" reset. These only restyle the drawn chart — no re-solve.
$("zoom-x").oninput = (e) => { zoomX = parseFloat(e.target.value) || 1; applyZoom(); };
$("zoom-y").oninput = (e) => { zoomY = parseFloat(e.target.value) || 1; applyZoom(); };
$("zoom-reset").onclick = () => {
  zoomX = 1;
  zoomY = 1;
  $("zoom-x").value = "1";
  $("zoom-y").value = "1";
  applyZoom();
};

// Example dropdown: fill it from /examples, and load the chosen example into the active plan.
loadExamples();
$("example-select").onchange = async (e) => {
  const name = e.target.value;
  if (!name) return;
  clearAlert();
  try {
    scenario = await getJSON(`/example/${name}`);
    selectedId = null;
    lastFeasibleSchedule = null; // a fresh plan must not show the previous plan's dimmed timeline
    resetRosterFilter();
    saveTabs(); // load the example into the active plan
    render();
  } catch (err) {
    showAlert(err.message);
  }
};

// Browse Library modal: open/close + live search/filter/sort (none of these re-solve).
$("browse-library").onclick = openLibrary;
$("library-close").onclick = closeLibrary;
$("library-modal").onclick = (e) => { if (e.target === $("library-modal")) closeLibrary(); }; // backdrop click
$("library-export").onclick = exportLibrary;
$("library-import").onclick = () => $("library-import-file").click();
$("library-import-file").onchange = (e) => { if (e.target.files[0]) importLibrary(e.target.files[0]); e.target.value = ""; };
let libSearchTimer = null;
$("library-search").oninput = (e) => {
  librarySearch = e.target.value;
  libraryPage = 0; // a new search starts at page 1
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(renderLibraryList, 120); // debounce so 600 cards don't rebuild per keystroke
};
// Segmented sort control (replaces the old dropdown).
for (const b of document.querySelectorAll(".lib-sort-btn")) {
  b.onclick = () => { librarySort = b.dataset.sort; libraryPage = 0; renderLibraryList(); };
}

// Inspector popup: close via × or a backdrop click (it opens on activity selection, below).
$("inspector-close").onclick = closeInspector;
$("inspector-modal").onclick = (e) => { if (e.target === $("inspector-modal")) closeInspector(); };

// Roster filter: debounced search over "On this plan". View-only — it never re-solves.
let rosterSearchTimer = null;
$("roster-search").oninput = (e) => {
  rosterSearch = e.target.value;
  clearTimeout(rosterSearchTimer);
  rosterSearchTimer = setTimeout(renderRoster, 120);
};

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("extract-modal").hidden) closeExtractModal();
  else if (!$("doc-chat-modal").hidden) closeDocChat();
  else if (!$("assistant-modal").hidden) closeAssistant();
  else if (!$("library-modal").hidden) closeLibrary();
  else if (!$("constraint-modal").hidden) closeAddConstraintModal();
  else if (!$("constraints-modal").hidden) closeConstraintsList();
  else if (!$("inspector-modal").hidden) closeInspector();
});

// "+ New": author a template straight into the Library (persisted in localStorage). A template is
// { label, minutes, category, section }; a category carries its color + icon (in customTypes/TYPES).
function addCustomTemplate() {
  const name = $("lib-new-name").value.trim();
  const minutes = parseInt($("lib-new-min").value, 10);
  const cat = $("lib-new-cat").value.trim();
  const section = $("lib-new-section").value.trim();
  if (!name) { $("lib-new-name").focus(); return; }
  if (!Number.isInteger(minutes) || minutes < 1) { $("lib-new-min").focus(); return; }
  // A category carries the color + icon; define/update it so bars, the legend, and rows pick it up.
  if (cat) {
    const styled = { label: cat, color: $("lib-new-color").value };
    customTypes[cat] = styled;
    TYPES[cat] = styled;
    saveTypes();
  }
  const tpl = { label: name, minutes, category: cat || null, section: section || null };
  const i = customTemplates.findIndex((t) => String(t.label).toLowerCase() === name.toLowerCase());
  if (i > -1) customTemplates[i] = tpl;
  else customTemplates.push(tpl);
  saveTemplates();
  $("lib-new-name").value = "";
  $("lib-new-cat").value = "";
  $("lib-new-section").value = "";
  $("lib-new-min").value = "30";
  renderLibraryList();
  flash(`Saved “${name}” to library`);
  $("lib-new-name").focus();
}
// Typing a known category prefills its color + icon (so you edit, not overwrite, its styling).
function syncNewTypeStyle() {
  const t = TYPES[$("lib-new-cat").value.trim()];
  if (t && t.color) $("lib-new-color").value = t.color;
}
$("lib-new-add").onclick = addCustomTemplate;
$("lib-new-name").addEventListener("keydown", (e) => { if (e.key === "Enter") addCustomTemplate(); });
$("lib-new-cat").addEventListener("input", syncNewTypeStyle);

// The scenario the SOLVER sees. `horizon` is a real solver bound, but only as a MULTI-DAY window:
// we forward it only when it's longer than one day. A sub-day horizon stays a cosmetic capacity-bar
// budget — sending it would turn an existing single-day plan INFEASIBLE. Extra UI-only keys (e.g. an
// activity's `type` for color) are harmless — the IR ignores fields it doesn't define.
function solvePayload() {
  const { horizon, ...rest } = scenario;
  if (horizon && horizon > DAY) rest.horizon = horizon;
  return rest;
}

// Solve the current in-memory scenario and draw the timeline. Reused by the
// manual "Solve now" button and by the debounced live auto-solve below.
function solveNow() {
  saveTabs(); // persist the current plan into its tab before solving
  // Reflect the in-flight solve on the status pill so it never shows a stale (possibly wrong) result.
  const _pill = $("status");
  if (_pill) { _pill.textContent = "SOLVING…"; _pill.className = "pill pill-warn"; }
  return withBusy($("solve-btn"), "Solving…", async () => {
    lastFill = null; // a live solve replaces any on-demand fill view
    renderResult(await post("/solve", solvePayload()));
  });
}

// ---- fill mode (on demand) ------------------------------------------------
// "Fill window" packs the horizon: every activity becomes optional and /fill keeps
// the mix with the most scheduled minutes. A separate solve path — the live /solve
// loop is untouched. The report is held here so renderHealth can show per-section
// utilization; any normal solve clears it (the live view is back in charge).
let lastFill = null;

function fillNow() {
  saveTabs();
  const _pill = $("status");
  if (_pill) { _pill.textContent = "PACKING…"; _pill.className = "pill pill-warn"; }
  return withBusy($("fill-btn"), "Packing…", async () => {
    const result = await post("/fill", solvePayload());
    lastFill = result.fill || null;
    renderResult(result);
    const out = result.left_out || [];
    if (out.length) {
      flash(`Packed ${result.schedule.length} of ${result.schedule.length + out.length} — left out: ` +
            out.slice(0, 6).join(", ") + (out.length > 6 ? ` +${out.length - 6} more` : ""));
    } else if (result.schedule) {
      flash(`Everything fits — ${result.schedule.length} scheduled`);
    }
  });
}

// Live auto-solve: re-solve ~250ms after the last edit (trailing debounce).
let solveTimer = null;
function scheduleSolve() {
  recordHistory(); // snapshot the live plan for undo/redo (debounced; no-op if nothing changed)
  clearTimeout(solveTimer);
  // Editing an Add-constraint draft (not yet in the plan): don't re-solve the live plan, and don't
  // let an empty-plan draft edit fall through to clearResult() below and wipe the timeline.
  if ($("constraint-modal") && !$("constraint-modal").hidden) return;
  // No activities to solve (e.g. you just deleted the last one). There's nothing to draw, so
  // clear the timeline + health instead of leaving the previous solve's bars on screen.
  if (!scenario.activities.length) {
    clearResult();
    return;
  }
  solveTimer = setTimeout(() => solveNow(), 250);
}

// Wipe the result UI back to its empty state: no timeline, no health strip, no status pill, and
// forget the last good schedule so a fresh plan doesn't show a stale "last good plan".
// A friendly placeholder for the timeline panel when there's nothing to draw (empty plan, or a plan
// that can't be solved), so the center panel never reads as "broken" during a demo.
function showTimelinePlaceholder(msg) {
  const tl = $("timeline");
  if (!tl) return;
  tl.innerHTML = "";
  tl.append(makeEl("p", msg, "timeline-empty"));
}

function clearResult() {
  lastFeasibleSchedule = null;
  lastFill = null;
  shownSchedule = null;
  shownStale = false;
  solvedHorizon = DAY;
  showTimelinePlaceholder("No plan yet — open Browse Library to add activities.");
  $("health").hidden = true;
  $("banner").hidden = true;
  const pill = $("status");
  pill.textContent = "";
  pill.className = "pill";
}

// "+ Constraint" opens a focused popup: pick a type, fill its fields, then Add. The draft lives
// here until committed, so the constraint is fully configured BEFORE it joins the plan — no more
// blank card appearing at the bottom of a long list.
let draftConstraint = null;
// When set, the add-constraint popup is in EDIT mode: committing REPLACES this constraint (by id)
// instead of pushing a new one. Cleared whenever the popup closes.
let editingConstraintId = null;
$("add-constraint").onclick = () => openAddConstraintModal();
$("constraint-commit").onclick = commitDraftConstraint;
$("constraint-cancel").onclick = closeAddConstraintModal;
$("constraint-close").onclick = closeAddConstraintModal;
$("constraint-modal").onclick = (e) => { if (e.target === $("constraint-modal")) closeAddConstraintModal(); };
// Changing the type reseeds the draft (keeping any label already typed) and rebuilds its fields.
$("add-constraint-type").onchange = () => {
  const label = draftConstraint ? draftConstraint.label : "";
  draftConstraint = newConstraint($("add-constraint-type").value);
  draftConstraint.label = label;
  renderConstraintDraft();
};

// The Constraints LIST lives in its own popup so the left panel never grows with every rule.
$("open-constraints").onclick = openConstraintsList;
$("constraints-close").onclick = closeConstraintsList;
$("constraints-modal").onclick = (e) => { if (e.target === $("constraints-modal")) closeConstraintsList(); };
$("con-search").oninput = (e) => { conSearch = e.target.value; constraintsPage = 0; renderConstraints(); };
function openConstraintsList() {
  $("constraints-modal").hidden = false; // show first, so the grid has a measurable size
  renderConstraints();
  $("con-search").focus(); // move keyboard focus into the dialog
}
function closeConstraintsList() {
  $("constraints-modal").hidden = true;
}
// Re-page when the window resizes (more/fewer cards fit), but only while the modal is open.
window.addEventListener("resize", () => {
  if (!$("constraints-modal").hidden) renderConstraints();
});

function openAddConstraintModal() {
  editingConstraintId = null;
  $("constraint-modal-title").textContent = "Add constraint";
  $("constraint-commit").textContent = "+ Add constraint";
  draftConstraint = newConstraint($("add-constraint-type").value);
  renderConstraintDraft();
  $("constraint-modal").hidden = false;
  $("add-constraint-type").focus();
}
// EDIT an existing constraint in the same popup: load a copy as the draft, switch the popup into
// edit mode (title + commit button), then commitDraftConstraint() replaces the original in place.
function openEditConstraintModal(c) {
  editingConstraintId = c.id;
  draftConstraint = JSON.parse(JSON.stringify(c));
  $("add-constraint-type").value = c.type;
  $("constraint-modal-title").textContent = "Edit constraint";
  $("constraint-commit").textContent = "Save";
  renderConstraintDraft();
  $("constraint-modal").hidden = false;
  $("add-constraint-type").focus(); // move keyboard focus into the dialog
}
function closeAddConstraintModal() {
  $("constraint-modal").hidden = true;
  draftConstraint = null;
  editingConstraintId = null;
  $("constraint-modal-title").textContent = "Add constraint";
  $("constraint-commit").textContent = "+ Add constraint";
}
// Build the modal body from the SAME field helpers the constraint cards use, so every type stays
// in sync — a label field on top, then the type-specific fields.
function renderConstraintDraft() {
  const form = $("constraint-form");
  if (!form) return;
  form.innerHTML = "";
  if (!draftConstraint) return;
  form.append(labeledField("label", textInput(draftConstraint.label || "",
    (v) => (draftConstraint.label = v), "constraint label")));
  for (const f of constraintFields(draftConstraint)) form.append(f);
  // A plan with no activities can't take a meaningful constraint (the refs would be empty and the
  // solver silently drops them), so block committing one until there's something to constrain.
  const commit = $("constraint-commit");
  if (commit) commit.disabled = !scenario.activities.length;
}
function commitDraftConstraint() {
  if (!draftConstraint) return;
  if (editingConstraintId) {
    // Edit mode: replace the original constraint in place (keep its id so refs/filters stay stable).
    draftConstraint.id = editingConstraintId;
    const i = scenario.constraints.findIndex((c) => c.id === editingConstraintId);
    if (i >= 0) scenario.constraints[i] = draftConstraint;
    else scenario.constraints.push(draftConstraint); // its row vanished — fall back to adding it
  } else {
    scenario.constraints.push(draftConstraint);
  }
  const _edited = !!editingConstraintId;
  draftConstraint = null;
  closeAddConstraintModal();
  render();
  flash(_edited ? "Constraint updated" : "Constraint added");
}

// Ctrl/Cmd+Enter parses from the text box (the AI input is hidden for now, but still wired up).
$("sentence").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("parse-btn").click();
});

// On open: restore the saved plans, or start with one empty plan. Either way, load the
// activity library before the first render so renderLibrary + colorFor have their data.
(async () => {
  await loadLibrary();
  loadTemplates();
  loadTypes();
  loadRecents();
  if (loadTabs()) {
    scenario = clone(tabs[activeTab].scenario);
  } else {
    scenario = { activities: [], constraints: [] };
    tabs = [{ name: "Plan 1", scenario: clone(scenario) }];
    activeTab = 0;
    saveTabs();
  }
  resetHistory(); // baseline the undo history for the plan we just loaded
  wireGanttTooltip(); // one delegated timeline tooltip, wired once
  renderTabs();
  render();
})();

// ---- tabs (saved plans, kept in the browser) ---------------------------
// Snapshot the live plan into the active tab and persist all tabs to localStorage.
function saveTabs() {
  if (tabs[activeTab]) tabs[activeTab].scenario = clone(scenario);
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeTab }));
  } catch {
    /* storage unavailable — skip persistence */
  }
}
// Restore tabs from localStorage; returns false if there's nothing saved.
function loadTabs() {
  try {
    const data = JSON.parse(localStorage.getItem(TABS_KEY));
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
    tabs = data.tabs;
    activeTab = Math.min(Math.max(0, data.activeTab | 0), tabs.length - 1);
    return true;
  } catch {
    return false;
  }
}
// Draw the tab strip: a chip per plan (click to open, double-click to rename, × to delete) + "+".
function renderTabs() {
  const bar = $("tabs");
  if (!bar) return;
  bar.innerHTML = "";
  tabs.forEach((t, i) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (i === activeTab ? " active" : "");
    const name = makeEl("button", t.name, "tab-name");
    name.type = "button";
    name.title = "Click to open · double-click to rename";
    name.onclick = () => switchTab(i);
    name.ondblclick = () => renameTab(i);
    tab.append(name);
    if (tabs.length > 1) {
      const x = makeEl("button", "×", "tab-close");
      x.type = "button";
      x.title = "Delete this plan";
      x.onclick = (e) => { e.stopPropagation(); deleteTab(i); };
      tab.append(x);
    }
    bar.append(tab);
  });
  const add = makeEl("button", "+", "tab-add");
  add.type = "button";
  add.title = "New plan";
  add.onclick = newTab;
  bar.append(add);
}
function switchTab(i) {
  if (i === activeTab) return;
  saveTabs(); // keep the current plan's edits
  activeTab = i;
  scenario = clone(tabs[i].scenario);
  selectedId = null;
  resetRosterFilter();
  resetHistory();
  renderTabs();
  render();
}
function newTab() {
  saveTabs();
  tabs.push({ name: `Plan ${tabs.length + 1}`, scenario: { activities: [], constraints: [] } });
  activeTab = tabs.length - 1;
  scenario = clone(tabs[activeTab].scenario);
  selectedId = null;
  resetRosterFilter();
  resetHistory();
  saveTabs();
  renderTabs();
  render();
}
function deleteTab(i) {
  if (tabs.length <= 1) return; // always keep at least one plan
  // This wipes the plan AND resets undo (see below), so it's unrecoverable — confirm first.
  if (!confirm(`Delete plan "${tabs[i].name}"? This can't be undone.`)) return;
  tabs.splice(i, 1);
  if (i < activeTab || activeTab >= tabs.length) activeTab = Math.max(0, activeTab - 1);
  scenario = clone(tabs[activeTab].scenario);
  selectedId = null;
  resetRosterFilter();
  resetHistory();
  saveTabs();
  renderTabs();
  render();
}
function renameTab(i) {
  const name = prompt("Rename plan:", tabs[i].name);
  if (name && name.trim()) {
    tabs[i].name = name.trim();
    saveTabs();
    renderTabs();
  }
}

// ---- undo / redo (per plan) --------------------------------------------
// Record the current scenario into history, debounced so a burst of edits (typing a name, dragging
// a slider) collapses into ONE undo step. scheduleSolve() — which every mutation funnels through —
// is the single call site, so we don't have to instrument each individual edit.
function recordHistory() {
  updateHistoryButtons();              // reflect the pending change in the buttons right away
  clearTimeout(histTimer);
  histTimer = setTimeout(flushHistory, 400);
}
// Commit any pending change onto the undo stack. Idempotent: a no-op when nothing changed.
function flushHistory() {
  clearTimeout(histTimer);
  const cur = JSON.stringify(scenario);
  if (cur === histPresent) return;
  histUndo.push(histPresent);
  if (histUndo.length > 50) histUndo.shift(); // bound memory
  histPresent = cur;
  histRedo = [];                              // a fresh edit abandons the redo path
  updateHistoryButtons();
}
// Start a clean history baseline for the current scenario (on load and whenever we switch plans, so
// undo never crosses from one plan into another).
function resetHistory() {
  clearTimeout(histTimer);
  histUndo = [];
  histRedo = [];
  histPresent = JSON.stringify(scenario);
  // resetHistory only runs when the whole plan is replaced (load / switch / new / delete /
  // duplicate / import), so the previous plan's last-good schedule no longer applies — forget it
  // or an INFEASIBLE new plan would draw the OLD plan's bars dimmed.
  lastFeasibleSchedule = null;
  updateHistoryButtons();
}
function undo() {
  flushHistory();                  // bank the latest in-flight edit first, so it's undoable
  if (!histUndo.length) return;
  histRedo.push(histPresent);
  histPresent = histUndo.pop();
  applyHistory();
  flash("Undone");
}
function redo() {
  if (!histRedo.length) return;
  histUndo.push(histPresent);
  histPresent = histRedo.pop();
  applyHistory();
  flash("Redone");
}
// Swap the live scenario to histPresent and refresh everything (render() re-solves). recordHistory
// fires from that render but no-ops, since scenario now equals histPresent.
function applyHistory() {
  scenario = JSON.parse(histPresent);
  selectedId = null;
  relaxedIds.clear(); // the plan changed — clear stale relaxed marks
  lastFeasibleSchedule = null; // undo/redo swaps the whole plan; don't keep the other state's bars
  resetRosterFilter();
  saveTabs();
  renderTabs();
  render();
  updateHistoryButtons();
}
function updateHistoryButtons() {
  const u = $("undo-btn"), r = $("redo-btn");
  if (u) u.disabled = !(histUndo.length || JSON.stringify(scenario) !== histPresent);
  if (r) r.disabled = !histRedo.length;
}

// ---- plan files (save / load / duplicate) ------------------------------
// Duplicate the active plan into a new tab and switch to it.
function duplicateTab() {
  saveTabs();
  const src = tabs[activeTab];
  tabs.push({ name: (src ? src.name : "Plan") + " copy", scenario: clone(scenario) });
  activeTab = tabs.length - 1;
  scenario = clone(tabs[activeTab].scenario);
  selectedId = null;
  resetRosterFilter();
  resetHistory();
  saveTabs();
  renderTabs();
  render();
}
// Save the active plan (its scenario + name) to a downloadable JSON file — the portable backup,
// since plans otherwise live only in localStorage (no DB, no cloud).
function exportPlan() {
  const name = (tabs[activeTab] && tabs[activeTab].name) || "plan";
  const blob = new Blob([JSON.stringify({ name, scenario }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[^\w.-]+/g, "_").toLowerCase() + ".plan.json";
  a.click();
  URL.revokeObjectURL(url);
}
// Load a plan file into a NEW tab (never overwrites the active plan). Accepts either the wrapped
// { name, scenario } shape exportPlan writes, or a bare scenario { activities, constraints }.
function importPlan(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { showAlert("Couldn't import — not a valid JSON plan file."); return; }
    const sc = data && data.scenario ? data.scenario : data;
    if (!sc || !Array.isArray(sc.activities) || !Array.isArray(sc.constraints)) {
      showAlert("Couldn't import — the file isn't a plan (needs activities + constraints).");
      return;
    }
    saveTabs();
    tabs.push({ name: (data && data.name) || "Imported plan", scenario: clone(sc) });
    activeTab = tabs.length - 1;
    scenario = clone(sc);
    selectedId = null;
    resetRosterFilter();
    resetHistory();
    saveTabs();
    renderTabs();
    render();
  };
  reader.readAsText(file);
}

// ---- document import (.docx -> extract -> review -> confirm-load) --------
// The extracted {scenario, coverage, warnings} waiting for the user's confirm. It is NOT loaded into
// the planner until they click "Load into new plan" — a deterministic/LLM pass can drop or mis-read a
// rule, so a human eyeballs the activities + constraints (and the coverage report) FIRST.
let pendingExtract = null;

async function runExtract(file) {
  await withBusy($("plan-import-doc"), "Reading…", async () => {
    const fd = new FormData();
    fd.append("document", file, file.name);
    let r;
    try {
      r = await fetch("/extract", { method: "POST", body: fd }); // multipart, not JSON — no post() helper
    } catch {
      throw new Error("Could not reach the server — is the Flask app running?");
    }
    const data = await safeJSON(r);
    if (!r.ok) throw new Error((data && data.error) || `Import failed (${r.status}).`);
    pendingExtract = data;
    renderExtractReview(data);
    openExtractModal();
  });
}

function openExtractModal() {
  // Focus the TITLE, not the confirm button — the point of this dialog is to
  // review before loading, so don't tee up a blind confirmation.
  openDialog("extract-modal", "extract-title");
}
function closeExtractModal() {
  closeDialog("extract-modal");
  pendingExtract = null; // discard on cancel/close; confirmExtractLoad reads it BEFORE closing
}

// Load the reviewed scenario into a fresh plan tab (same path as importPlan). Kept separate so the
// import always opens a NEW tab and never clobbers the plan the user is on.
function confirmExtractLoad() {
  let sc = pendingExtract && pendingExtract.scenario;
  // Nothing was extracted -> nothing to load (the button is disabled, but guard other paths too).
  if (!sc || !Array.isArray(sc.activities) || !sc.activities.length) { closeExtractModal(); return; }
  sc = clone(sc);

  // Merge the deep-read proposals the reviewer left CHECKED (see renderDeepProposals).
  const deep = pendingExtract.deep;
  if (deep) {
    const checkedIdx = (kind) =>
      [...document.querySelectorAll(`#extract-deep input[data-kind="${kind}"]:checked`)]
        .map((cb) => Number(cb.dataset.idx));
    const ids = new Set(sc.activities.map((a) => a.id));
    for (const i of checkedIdx("activity")) {
      const a = { ...deep.activities[i] };
      delete a._guessed_duration; // UI hint, not an IR field
      if (a.id && !ids.has(a.id)) { sc.activities.push(a); ids.add(a.id); }
    }
    for (const i of checkedIdx("constraint")) sc.constraints.push({ ...deep.constraints[i] });
  }
  // Review-added rules (cross-ref picks, deep-read accepts) arrive without ids — fill
  // them here so the constraints modal's toggles address the right rows.
  const usedIds = new Set(sc.constraints.map((c) => c.id).filter(Boolean));
  let nextId = 1;
  for (const c of sc.constraints) {
    if (!c.id) { while (usedIds.has(`c${nextId}`)) nextId++; c.id = `c${nextId}`; usedIds.add(c.id); }
    if (c.enabled === undefined) c.enabled = true;
  }

  // Apply the load options (see renderExtractReview): the chosen window length, and
  // the optional day-hours rule — a normal constraint the user can edit or disable.
  const days = parseInt($("extract-horizon-days") && $("extract-horizon-days").value, 10);
  if (Number.isFinite(days) && days >= 1) sc.horizon = days * DAY;
  const dayChk = $("extract-dayhours");
  if (dayChk && dayChk.checked) {
    const used = new Set(sc.constraints.map((c) => c.id));
    let n = 1;
    while (used.has(`c${n}`)) n++;
    sc.constraints.push({
      id: `c${n}`, type: "working_window", section: "all",
      open: "08:00", close: "20:00", days: "all", enabled: true,
      priority: 3, label: "Day hours (added at import)", source: "",
      rationale: "Added at import so work lands in day hours — edit or disable freely.",
    });
  }

  saveTabs();
  tabs.push({ name: "Imported doc", scenario: clone(sc) });
  activeTab = tabs.length - 1;
  scenario = clone(sc);
  selectedId = null;
  lastFeasibleSchedule = null; // a fresh plan must not show the previous plan's dimmed timeline
  resetRosterFilter();
  resetHistory();
  saveTabs();
  renderTabs();
  render();
  closeExtractModal();
  flash(`Loaded ${sc.activities.length} activities from the document`);
}

// The deep-read proposals: what the local model found that the rules didn't. Every item is a
// labeled checkbox (checked = merged at Load) with its evidence quote; "couldn't model" items
// are listed read-only so nothing the model reported disappears silently.
function renderDeepProposals(box, deep) {
  const nA = (deep.activities || []).length;
  const nC = (deep.constraints || []).length;
  box.append(makeEl("div",
    `🧠 Deep read (${deep.calls || 0} model call(s)): ${nC} rule(s) and ${nA} new activit${nA === 1 ? "y" : "ies"} proposed — check what to load`,
    "extract-deep-head"));

  const item = (kind, idx, text, evidence, checked) => {
    const li = makeEl("li", "", "extract-deep-item");
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.dataset.kind = kind;
    cb.dataset.idx = String(idx);
    lab.append(cb);
    lab.append(makeEl("span", " " + text));
    li.append(lab);
    if (evidence) li.append(makeEl("div", `“${evidence}”`, "extract-deep-quote"));
    return li;
  };

  if (nC) {
    const ul = makeEl("ul", "", "extract-notes-list");
    (deep.constraints || []).forEach((c, i) =>
      ul.append(item("constraint", i, c.label || constraintSummary(c), c.source, true)));
    box.append(ul);
  }
  if (nA) {
    box.append(makeEl("div", "New activities the rules didn't extract:", "extract-deep-sub"));
    const ul = makeEl("ul", "", "extract-notes-list");
    (deep.activities || []).forEach((a, i) => {
      const dur = a._guessed_duration ? "duration unknown — 8h guessed" : fmtMinutes(a.duration);
      ul.append(item("activity", i,
        `${a.label} (${dur}${a.section ? `, section ${a.section}` : ""}${a.recurs_daily ? ", daily" : ""})`,
        a.source, true));
    });
    box.append(ul);
  }
  if (!nA && !nC) box.append(makeEl("div", "The model found nothing the rules hadn't already read.", "extract-deep-sub"));

  const couldnt = deep.couldnt_model || [];
  if (couldnt.length) {
    const d = makeEl("details", "", "extract-notes");
    d.append(makeEl("summary", `Couldn't model (${couldnt.length}) — read, but no rule type fits yet`));
    const ul = makeEl("ul", "", "extract-notes-list");
    for (const u of couldnt) ul.append(makeEl("li", `“${u.phrase}” — ${u.reason}`));
    d.append(ul);
    box.append(d);
  }
  for (const e of deep.errors || []) box.append(makeEl("div", "⚠ " + e, "extract-flag"));
}

// Build the read-only review: a coverage summary, extraction notes, then the activity + constraint
// tables. Everything is set via textContent (makeEl), so raw document text can never inject markup.
// The "bad doc" state: a valid .docx the extractor found nothing schedulable in. Rather than a
// blank, loadable plan, tell the user what happened and what to do next (the app already knows —
// coverage carries a near-miss id hint when the cause is a wrong id separator like "[SH 801]").
function renderExtractEmpty(body, coverage, warnings) {
  const box = makeEl("div", "", "extract-empty");
  box.append(makeEl("div", "📄  Nothing to schedule was found in this document.", "extract-empty-title"));
  box.append(makeEl("p",
    "This tool reads requirements written like [REQ-123] with an estimated duration, " +
    "or a day-by-day schedule table. It didn’t find either one here.",
    "extract-empty-body"));

  // The likely cause, when we can name it: bracketed tags with the wrong separator.
  const nm = coverage.near_miss_ids;
  if (nm && nm.count) {
    const hint = makeEl("div", "", "extract-flags");
    const f = makeEl("div", "", "extract-flag");
    const plural = nm.count === 1 ? "" : "s";
    f.append(makeEl("span", `Found ${nm.count} tag${plural} like `));
    f.append(makeEl("code", nm.example_found));
    f.append(makeEl("span", " — did you mean "));
    f.append(makeEl("code", nm.example_fixed));
    f.append(makeEl("span", "? I only read requirement ids joined by a hyphen. "
      + "Replace the space with a hyphen and re-import."));
    hint.append(f);
    box.append(hint);
  }

  box.append(makeEl("p",
    "You can still ask this document questions with 💬 Ask the doc, or close this and build a plan by hand.",
    "extract-empty-body"));
  body.append(box);

  // Keep the raw extraction notes available for anyone who wants the detail.
  if (warnings.length) {
    const d = makeEl("details", "", "extract-notes");
    d.append(makeEl("summary", `Notes from extraction (${warnings.length})`));
    const ul = makeEl("ul", "", "extract-notes-list");
    for (const w of warnings) ul.append(makeEl("li", w));
    d.append(ul);
    body.append(d);
  }
}

function renderExtractReview(result) {
  const scenario = result.scenario || { activities: [], constraints: [] };
  const coverage = result.coverage || {};
  const warnings = result.warnings || [];
  const ext = coverage.extraction || {};
  const body = $("extract-body");
  body.innerHTML = "";
  const nA = scenario.activities.length;

  // Nothing schedulable was found — don't offer to load an empty plan. Say what happened,
  // hint the likely cause (id format), and point to what still works. This is the "bad doc"
  // gate: a valid .docx that carries no requirements/schedule the extractor can read.
  if (nA === 0) {
    renderExtractEmpty(body, coverage, warnings);
    $("extract-foot-note").textContent = "Nothing was loaded — your current plan is untouched.";
    const load = $("extract-load");
    load.textContent = "Nothing to load";
    load.disabled = true;
    return;
  }
  $("extract-load").disabled = false;  // re-enable if a previous import was empty

  // Summary chips: the trust headline (how much was read by rules, not guessed).
  const summary = makeEl("div", "", "extract-summary");
  const chip = (val, label) => {
    const c = makeEl("div", "", "extract-chip");
    c.append(makeEl("span", String(val), "extract-chip-val"));
    c.append(makeEl("span", label, "extract-chip-lbl"));
    return c;
  };
  summary.append(chip(nA, "activities"));
  summary.append(chip(scenario.constraints.length, "constraints"));
  if (ext.by_method && ext.by_method.deterministic != null)
    summary.append(chip(`${ext.by_method.deterministic}/${nA}`, "durations by rule"));
  if (ext.dependencies) summary.append(chip(ext.dependencies.deterministic, "dependencies"));
  if (ext.dated_deadlines != null) summary.append(chip(ext.dated_deadlines, "deadlines"));
  if (ext.rationales) summary.append(chip(ext.rationales, "rationales"));
  if (coverage.start_date) summary.append(chip(coverage.start_date, "project start"));
  if (coverage.horizon_days != null) summary.append(chip(coverage.horizon_days, "horizon (days)"));
  // Schedule-genre docs (day tables + rule bullets) report different coverage.
  if (coverage.genre === "schedule") {
    if (coverage.n_rows != null) summary.append(chip(coverage.n_rows, "table rows"));
    const bl = coverage.bullets || [];
    summary.append(chip(`${bl.filter((b) => b.status === "modeled").length}/${bl.length}`, "rules modeled"));
  }
  body.append(summary);

  // Coverage tripwires: requirements found in the doc but NOT extracted, or constraints pointing at a
  // missing activity. These are the "silently dropped a rule" cases — surface them loudly.
  const flags = [];
  if (coverage.not_extracted && coverage.not_extracted.length)
    flags.push(`${coverage.not_extracted.length} requirement(s) in the doc were NOT extracted: ${coverage.not_extracted.join(", ")}`);
  if (coverage.duplicate_ids && coverage.duplicate_ids.length)
    flags.push(`${coverage.duplicate_ids.length} requirement id(s) are defined MORE THAN ONCE in the doc — the copies may disagree; the first definition won: ${coverage.duplicate_ids.join(", ")}`);
  if (coverage.dangling_references && coverage.dangling_references.length)
    flags.push(`${coverage.dangling_references.length} constraint(s) reference a missing activity.`);
  // Schedule genre: rule bullets we couldn't model, and self-check violations (the
  // document's own timetable breaking one of the rules we extracted from it).
  const unmodeled = (coverage.bullets || []).filter((b) => b.status === "unmodeled");
  if (unmodeled.length)
    flags.push(`${unmodeled.length} rule bullet(s) could not be modeled — shown in the notes, NOT enforced.`);
  const selfCheck = coverage.self_check;
  const jumpFlags = [];  // {text, cid} — clicking one scrolls to the constraint it's about
  if (selfCheck && selfCheck.violations && selfCheck.violations.length) {
    flags.push(`Self-check: the document's own timetable breaks ${selfCheck.violations.length} extracted rule(s) — it may contradict itself:`);
    for (const v of selfCheck.violations.slice(0, 8))
      jumpFlags.push({ text: `   ${v.label || v.constraint} (day ${v.day + 1}): ${v.detail}`,
                       cid: v.constraint });
    if (selfCheck.violations.length > 8)
      flags.push(`   …and ${selfCheck.violations.length - 8} more.`);
  }
  if (flags.length || jumpFlags.length) {
    const box = makeEl("div", "", "extract-flags");
    for (const f of flags) box.append(makeEl("div", "⚠ " + f, "extract-flag"));
    for (const jf of jumpFlags) {
      // a flag you can click: scrolls to and flashes the row it's about
      const b = document.createElement("button");
      b.type = "button";
      b.className = "extract-flag";
      b.textContent = "⚠ " + jf.text + " — show me";
      b.onclick = () => {
        const row = body.querySelector(`tr[data-cid="${jf.cid}"]`);
        if (!row) return;
        row.scrollIntoView({ block: "center" });
        row.classList.remove("flash-highlight");
        void row.offsetWidth; // restart the animation on repeat clicks
        row.classList.add("flash-highlight");
      };
      box.append(b);
    }
    body.append(box);
  }

  // Unresolved cross-references: the rules saw "[SH-x] … [SH-y]" phrasing they could neither
  // capture as a dependency nor dismiss as narration. NEVER auto-added (deterministic edges
  // stay authoritative) — each row shows the doc phrase and offers BOTH directions; the human
  // picks one, and the constraint joins the pending scenario before Load.
  const ambiguous = ((ext.cross_references || {}).ambiguous || []);
  if (ambiguous.length) {
    const d = makeEl("details", "", "extract-notes extract-xrefs");
    d.open = true;
    d.append(makeEl("summary",
      `Needs your review: ${ambiguous.length} possible dependenc${ambiguous.length === 1 ? "y" : "ies"} the rules couldn't confirm`));
    const ul = makeEl("ul", "", "extract-notes-list");
    const normId = (raw) => raw.toLowerCase().replace(/-/g, "_");
    for (const x of ambiguous) {
      const li = makeEl("li", "");
      li.append(makeEl("span", `[${x.requirement}] mentions [${x.references}]: “${x.phrase}” `));
      const addBtn = (beforeRaw, afterRaw) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "extract-xref-add";
        b.textContent = `add: ${beforeRaw} → ${afterRaw}`;
        b.title = `Add a precedence rule: ${beforeRaw} must finish before ${afterRaw} starts`;
        b.onclick = () => {
          scenario.constraints.push({
            type: "precedence",
            before: normId(beforeRaw),
            after: normId(afterRaw),
            label: `${afterRaw} after ${beforeRaw} (added in review)`,
            source: x.phrase,
            priority: 3,
            rationale: "Off-format cross-reference confirmed by the reviewer at import.",
          });
          for (const btn of li.querySelectorAll("button")) btn.disabled = true;
          li.append(makeEl("span", " ✓ added", "extract-xref-added"));
        };
        return b;
      };
      li.append(addBtn(x.references, x.requirement));
      li.append(addBtn(x.requirement, x.references));
      ul.append(li);
    }
    d.append(ul);
    body.append(d);
  }

  // Deep read: the local model sweeps the WHOLE document for scheduling facts the rules
  // can't see (relations stated by name, recurrence, tasks without ids). It returns
  // PROPOSALS only — each one shows its evidence quote and is accepted or rejected here,
  // before Load. Nothing the model says enters the plan unreviewed.
  const deepBox = makeEl("div", "", "extract-deep");
  deepBox.id = "extract-deep";
  if (result.deep) {
    renderDeepProposals(deepBox, result.deep);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "deep-read-btn";
    btn.className = "extract-deep-btn";
    btn.textContent = "🧠 Deep read (local model)";
    btn.title = "Sweep the whole document with the local model for rules the deterministic pass can't read — you review every proposal before it loads.";
    btn.onclick = async () => {
      btn.disabled = true;
      const t0 = Date.now();
      const tick = setInterval(() => {
        btn.textContent = `🧠 Reading the document… ${Math.round((Date.now() - t0) / 1000)}s`;
      }, 1000);
      try {
        const resp = await post("/deep_read", { scenario: result.scenario });
        result.deep = resp; // rides on pendingExtract; confirmExtractLoad merges the checked items
        deepBox.innerHTML = "";
        renderDeepProposals(deepBox, resp);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "🧠 Deep read (local model)";
        showAlert(err.message || String(err));
      } finally {
        clearInterval(tick);
      }
    };
    deepBox.append(btn);
    deepBox.append(makeEl("span",
      "Optional: the local model reads the whole document for rules the deterministic pass can't see.",
      "extract-deep-note"));
  }
  body.append(deepBox);

  // Notes from extraction (the deterministic-first headline + every warning), collapsible.
  if (warnings.length) {
    const d = makeEl("details", "", "extract-notes");
    d.open = true;
    d.append(makeEl("summary", `Notes from extraction (${warnings.length})`));
    const ul = makeEl("ul", "", "extract-notes-list");
    for (const w of warnings) ul.append(makeEl("li", w));
    d.append(ul);
    body.append(d);
  }

  // Load options: the two knobs that decide whether the first minute after loading
  // is usable — how long the window is, and whether work stays inside day hours.
  const optsBox = makeEl("div", "", "extract-options");
  optsBox.append(makeEl("span", "Load options:", "extract-options-label"));

  const daysWrap = makeEl("label", "", "extract-option");
  daysWrap.append(makeEl("span", "Plan over "));
  const daysIn = document.createElement("input");
  daysIn.type = "number";
  daysIn.id = "extract-horizon-days";
  daysIn.min = "1";
  daysIn.max = "365";
  daysIn.value = String(coverage.horizon_days || Math.max(1, Math.ceil((scenario.horizon || DAY) / DAY)));
  daysWrap.append(daysIn);
  daysWrap.append(makeEl("span", " days"));
  optsBox.append(daysWrap);
  // deadlines are day-anchored — shrinking the window below the last one un-binds it
  const lastDeadline = Math.max(-1, ...scenario.constraints
    .filter((c) => c.type === "time_window" && c.day != null).map((c) => c.day));
  if (lastDeadline >= 0)
    optsBox.append(makeEl("span", `(latest deadline: day ${lastDeadline + 1})`, "extract-option-hint"));

  // A spec doc states order, not clock time — without this the solver happily works
  // the crew at 03:00. Schedule docs carry their own rhythm rules, so no checkbox there.
  if (coverage.genre !== "schedule") {
    const dayWrap = makeEl("label", "", "extract-option");
    const dayChk = document.createElement("input");
    dayChk.type = "checkbox";
    dayChk.id = "extract-dayhours";
    dayChk.checked = true;
    dayWrap.append(dayChk);
    dayWrap.append(makeEl("span", " keep work inside 08:00–20:00 (adds an editable day-hours rule)"));
    optsBox.append(dayWrap);
  }
  body.append(optsBox);

  body.append(makeEl("h3", `Activities (${nA})`, "extract-section-title"));
  body.append(extractActivitiesTable(scenario.activities));
  body.append(makeEl("h3", `Constraints (${scenario.constraints.length})`, "extract-section-title"));
  body.append(extractConstraintsTable(scenario.constraints));

  $("extract-foot-note").textContent = "Loads into a NEW plan tab — your current plan is untouched.";
  // The confirm button states exactly what it commits, so a short count is a tell.
  $("extract-load").textContent =
    `Load ${nA} activities + ${scenario.constraints.length} constraints`;
}

function extractTableShell(headers, label) {
  const wrap = makeEl("div", "", "extract-table-wrap");
  // the wrap scrolls — make it keyboard-reachable and named for screen readers
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  if (label) wrap.setAttribute("aria-label", label);
  const table = makeEl("table", "", "extract-table");
  const thead = makeEl("thead");
  const hr = makeEl("tr");
  for (const h of headers) hr.append(makeEl("th", h));
  thead.append(hr);
  table.append(thead);
  const tb = makeEl("tbody");
  table.append(tb);
  wrap.append(table);
  return { wrap, tb };
}

function extractActivitiesTable(acts) {
  const { wrap, tb } = extractTableShell(
    ["id", "name", "duration", "section (resource)", "group / doc-section"],
    "Extracted activities");
  if (!acts.length) tb.append(oneCellRow(5, "No activities extracted."));
  for (const a of acts) {
    const tr = makeEl("tr");
    tr.append(makeEl("td", a.id, "extract-mono"));
    tr.append(makeEl("td", a.label || "—"));
    tr.append(makeEl("td", fmtMinutes(a.duration)));
    tr.append(makeEl("td", a.section || "—"));
    tr.append(makeEl("td", a.type || "—", "extract-dim"));
    tb.append(tr);
  }
  return wrap;
}

function extractConstraintsTable(cons) {
  const { wrap, tb } = extractTableShell(["pri", "type", "detail", "source"],
    "Extracted constraints");
  if (!cons.length) tb.append(oneCellRow(4, "No constraints extracted."));
  for (const c of cons) {
    const tr = makeEl("tr");
    if (c.id) tr.dataset.cid = c.id; // the self-check flags jump to rows by this
    const pt = makeEl("td");
    pt.append(priorityBadge(c.priority));
    tr.append(pt);
    tr.append(makeEl("td", c.type, "extract-mono"));
    tr.append(makeEl("td", extractConstraintDetail(c)));
    const src = makeEl("td", "", "extract-dim extract-src");
    src.append(makeEl("div", c.source || c.label || "—"));
    if (c.rationale) src.append(makeEl("div", "why: " + c.rationale, "extract-why"));
    tr.append(src);
    tb.append(tr);
  }
  return wrap;
}

function extractConstraintDetail(c) {
  if (c.type === "precedence") return `${c.before} → ${c.after}`;
  if (c.type === "time_window") {
    const parts = [];
    if (c.earliest) parts.push(`≥ ${c.earliest}`);
    if (c.latest_end) parts.push(`≤ ${c.latest_end}`);
    if (c.day != null) parts.push(`day ${c.day + 1}`);
    return `${c.activity}${parts.length ? ": " + parts.join(", ") : ""}`;
  }
  // Every other type reads best as the same one-liner the constraints table uses.
  return constraintSummary(c) || c.label || c.type;
}

function oneCellRow(span, text) {
  const tr = makeEl("tr");
  const td = makeEl("td", text, "extract-empty");
  td.colSpan = span;
  tr.append(td);
  return tr;
}

// Minutes -> a compact human label ("90 min" -> "1h 30m", "480" -> "8h", "5760" -> "4d").
function fmtMinutes(m) {
  m = Math.round(m || 0);
  if (m < 60) return `${m} min`;
  if (m % 1440 === 0) return `${m / 1440}d`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ---- chat panels: Ask the doc (RAG) + Plan assistant (typed tools) --------
// One bubble in a chat log. Everything is built with textContent, never markup.
// Only pin the log to the bottom when the reader is already there (don't yank
// them down while they're re-reading an earlier answer).
function chatBubble(log, text, cls) {
  const nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  const el = makeEl("div", text, "chat-msg " + cls);
  log.append(el);
  if (nearBottom) log.scrollTop = log.scrollHeight;
  return el;
}

// Render answer text into a bubble: minimal markdown (**bold**) and [n] citation
// chips that flash their source line. createElement/textContent only — no innerHTML.
function appendChatText(el, text) {
  const cites = [];
  text.split("**").forEach((part, i) => {
    const target = i % 2 ? makeEl("strong", "") : el;
    let last = 0;
    for (const m of part.matchAll(/\[(\d+)\]/g)) {
      target.append(part.slice(last, m.index));
      const cite = makeEl("sup", `[${m[1]}]`, "cite");
      cite.tabIndex = 0;
      cite.title = "Show the source this cites";
      cites.push([cite, m[1]]);
      target.append(cite);
      last = m.index + m[0].length;
    }
    target.append(part.slice(last));
    if (target !== el) el.append(target);
  });
  return cites;
}

// The "thinking" bubble for a 10–30s local-model wait: pulsing dots + elapsed
// seconds, so the wait reads as alive rather than hung. Remove with .stop().
function busyBubble(log, label) {
  const el = chatBubble(log, "", "chat-bot chat-busy");
  el.append(makeEl("span", label + " "));
  const dots = makeEl("span", "", "chat-dots");
  for (let i = 0; i < 3; i++) dots.append(makeEl("span", "·"));
  el.append(dots);
  const elapsed = makeEl("span", "", "chat-elapsed");
  el.append(elapsed);
  const started = Date.now();
  const timer = setInterval(() => {
    elapsed.textContent = ` ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  el.stop = () => { clearInterval(timer); el.remove(); };
  return el;
}

// An error message that says it's an error (icon + word, not color alone) and
// offers a one-click retry of the same question.
function chatErrorBubble(log, message, retry) {
  const el = chatBubble(log, "⚠ Error — " + message, "chat-bot chat-error");
  if (retry) {
    el.append(makeEl("br", ""));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-ghost btn-sm chat-retry";
    b.textContent = "↻ Retry";
    b.onclick = () => { el.remove(); retry(); };
    el.append(b);
  }
  return el;
}

// First open: say what the panel can do and offer example prompts to click —
// an empty scroll area teaches nothing.
function seedChatIntro(logId, inputId, ask, intro, suggestions) {
  const log = $(logId);
  if (log.childElementCount) return;
  const bubble = chatBubble(log, intro, "chat-bot");
  const row = makeEl("div", "", "chat-suggests");
  for (const s of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lib-chip";
    chip.append(makeEl("span", s, "lib-chip-label"));
    chip.onclick = () => { $(inputId).value = s; ask(); };
    row.append(chip);
  }
  bubble.append(row);
}

// Ask a question about the last imported document. The server answers from the
// document's own blocks and returns the source excerpts it used — shown under
// the answer so every claim can be checked against the doc.
async function askDoc(forcedQ) {
  const input = $("doc-chat-input");
  const q = (forcedQ || input.value).trim();
  if (!q || $("doc-chat-send").disabled) return;
  if (!forcedQ) input.value = "";
  const log = $("doc-chat-log");
  chatBubble(log, q, "chat-user");
  const busy = busyBubble(log, "Reading the document");
  $("doc-chat-send").disabled = true;
  try {
    const r = await post("/doc_chat", { question: q });
    busy.stop();
    const bubble = chatBubble(log, "", "chat-bot");
    const cites = appendChatText(bubble, r.answer);
    if (r.sources && r.sources.length) {
      // sources collapse behind a labeled count; each [n] chip flashes its line
      const details = makeEl("details", "", "chat-sources");
      details.append(makeEl("summary", `Sources (${r.sources.length})`));
      for (const s of r.sources) {
        const line = makeEl("div",
          `[${s.n}] ${s.section ? s.section + " — " : ""}${s.text.slice(0, 140)}`, "chat-source");
        line.dataset.n = s.n;
        details.append(line);
      }
      bubble.append(details);
      const flashSource = (n) => {
        details.open = true;
        const line = details.querySelector(`.chat-source[data-n="${n}"]`);
        if (!line) return;
        line.scrollIntoView({ block: "nearest" });
        line.classList.remove("flash-highlight");
        void line.offsetWidth;
        line.classList.add("flash-highlight");
      };
      for (const [cite, n] of cites) {
        cite.onclick = () => flashSource(n);
        cite.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flashSource(n); } };
      }
    }
    if (r.document) $("doc-chat-name").textContent = "· " + r.document;
  } catch (e) {
    busy.stop();
    chatErrorBubble(log, e.message, () => askDoc(q));
  } finally {
    $("doc-chat-send").disabled = false;
  }
}

// Tell the assistant what to change. The server edits a COPY of the plan through
// typed tools (each edit validated like a manual one) and returns the new scenario
// + a list of what changed. Applying it goes through the same history/undo/re-solve
// path as any hand edit, so Ctrl+Z takes it right back.
async function askAssistant(forcedText) {
  const input = $("assistant-input");
  const text = (forcedText || input.value).trim();
  if (!text || $("assistant-send").disabled) return;
  if (!forcedText) input.value = "";
  const log = $("assistant-log");
  chatBubble(log, text, "chat-user");
  const busy = busyBubble(log, "Working on the plan");
  $("assistant-send").disabled = true;
  try {
    const r = await post("/assist", { message: text, scenario: solvePayload() });
    busy.stop();
    const bubble = chatBubble(log, "", "chat-bot");
    appendChatText(bubble, r.reply || "Done.");
    if (r.actions && r.actions.length) {
      const acts = makeEl("div", "", "chat-actions");
      acts.append(makeEl("div", "Changes:"));
      for (const a of r.actions) acts.append(makeEl("div", "• " + a));
      bubble.append(acts);
    }
    if (r.changed && r.scenario) {
      flushHistory(); // commit any pending edits as their own undo step first
      const keepHorizon = scenario.horizon;
      scenario = clone(r.scenario);
      // solvePayload strips a cosmetic sub-day horizon; put it back unless the assistant set one.
      if (scenario.horizon == null && keepHorizon) scenario.horizon = keepHorizon;
      selectedId = null;
      saveTabs();
      render(); // re-render + live re-solve; recordHistory makes this one undo step
      // a visible way back, right on the confirmation (Ctrl+Z stays the shortcut)
      const undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "btn btn-ghost btn-sm chat-retry";
      undoBtn.textContent = "↶ Undo (Ctrl+Z)";
      undoBtn.onclick = () => { undo(); undoBtn.disabled = true; };
      bubble.append(undoBtn);
      flash(`Assistant: ${r.actions.length} change(s) — Undo takes them back`);
    }
  } catch (e) {
    busy.stop();
    chatErrorBubble(log, e.message, () => askAssistant(text));
  } finally {
    $("assistant-send").disabled = false;
  }
}

// ---- network ------------------------------------------------------------
async function getJSON(url) {
  const r = await fetch(url);
  const data = await safeJSON(r);
  if (!r.ok) throw new Error((data && data.error) || `${r.status} ${r.statusText}`);
  return data;
}

async function post(url, body) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server — is the Flask app running?");
  }
  const data = await safeJSON(r);
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || `Request failed (${r.status}).`;
    throw new Error(url === "/parse" ? `Parse failed: ${msg} (is Ollama running?)` : msg);
  }
  return data;
}

async function safeJSON(r) {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

// Disable a button + swap its label while an async action runs; restore + surface errors.
async function withBusy(btn, label, fn) {
  clearAlert();
  const original = btn.textContent;
  btn.disabled = true;
  btn.classList.add("busy");
  btn.textContent = label;
  try {
    await fn();
  } catch (err) {
    showAlert(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.textContent = original;
  }
}

// ---- alerts -------------------------------------------------------------
function showAlert(msg) {
  const a = $("alert");
  a.textContent = msg;
  a.hidden = false;
}
function clearAlert() {
  const a = $("alert");
  a.hidden = true;
  a.textContent = "";
}

// A brief, non-blocking success toast (bottom-center) — separate from the red #alert error banner, so
// a positive action (add / save / undo) gets visible confirmation without hijacking the error slot.
let _toastTimer = null;
function flash(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  t.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.classList.remove("show"); t.hidden = true; }, 1600);
}

// ---- IR helpers ---------------------------------------------------------
// Unique id from a base name (e.g. "sleep" -> sleep, sleep_2, sleep_3…). The bare base
// is tried first so the first of a kind reads cleanly; collisions get a numeric suffix.
function uniqueActivityId(base = "activity") {
  if (!scenario.activities.some((a) => a.id === base)) return base;
  let n = 2;
  let id;
  do {
    id = `${base}_${n++}`;
  } while (scenario.activities.some((a) => a.id === id));
  return id;
}
function uniqueConstraintId() {
  let n = 1;
  let id;
  do {
    id = `c${n++}`;
  } while (scenario.constraints.some((c) => c.id === id));
  return id;
}
// Register a constraint type in the "add constraint" picker if it isn't already listed.
function addConstraintType(type, label) {
  const sel = $("add-constraint-type");
  if (!sel || [...sel.options].some((o) => o.value === type)) return;
  const opt = document.createElement("option");
  opt.value = type;
  opt.textContent = label;
  sel.append(opt);
}
function newConstraint(type) {
  const a0 = scenario.activities[0]?.id || "";
  const a1 = scenario.activities[1]?.id || a0;
  // No baked-in numbers or titles: times start empty, the scale factor is the no-op 1, and the
  // label starts blank. The activity refs just point at whatever's already in the plan.
  const base = { id: uniqueConstraintId(), type, enabled: true, source: "", label: "", priority: 3, rationale: "" };
  if (type === "time_window")
    return { ...base, activity: a0, earliest: null, latest_end: null, day: null };
  if (type === "precedence")
    return { ...base, before: a0, after: a1 };
  if (type === "overlap")
    return { ...base, outer: a0, inner: a1, mode: "contains" };
  if (type === "time_lag")
    // Seed as adjacency (end→start, 0..0) — the most common use and, crucially, VALID on its own so
    // the live solve doesn't error the instant you add the rule (the IR needs >=1 bound). Adjust from there.
    return { ...base, from_id: a0, to_id: a1, from_anchor: "end", to_anchor: "start",
      min_lag: 0, max_lag: 0, day_shift: 0 };
  if (type === "min_separation")
    // A real buffer (minutes > 0) kept in either order; seed a small non-zero gap so it's valid.
    return { ...base, a: a0, b: a1, gap: 30, day_shift: 0 };
  if (type === "no_overlap")
    return { ...base, activities: "all" };
  if (type === "sequence") {
    // Seed the steps with the first two activities (or one, or none, depending on what exists).
    let steps = [];
    if (a0 && a1 !== a0) steps = [a0, a1];
    else if (a0) steps = [a0];
    return { ...base, activities: steps };
  }
  if (type === "conditional")
    return {
      ...base,
      when: { activity: a0, present: false },
      then: { set_duration: { activity: a1, factor: 1 } },
    };
  if (type === "working_window")
    return { ...base, section: "all", open: "09:00", close: "17:00", days: "all" };
  if (type === "section_budget") {
    // A budget is per-section, so seed it with a real section (not "all") and a cap at the
    // section's current usage, so it starts as a no-op the user can tighten.
    const sec = scenario.activities.map((a) => a.section && a.section.trim()).find(Boolean) || "";
    return { ...base, section: sec, max_minutes: sectionBusyMinutes(sec) || 480 };
  }
  return base;
}

// ---- rendering ----------------------------------------------------------
function render() {
  renderRoster();
  renderConstraints();
  renderInspector();
  // Keep the open "Add constraint" draft in sync when a field change triggers a rebuild.
  if (draftConstraint && $("constraint-modal") && !$("constraint-modal").hidden) renderConstraintDraft();
  scheduleSolve();
}

// ---- roster ("On this plan") -------------------------------------------
// A clickable list of every activity in the plan: swatch + name + section + solved time, with a
// × to remove it. Clicking a row selects that activity (highlights its bar + opens the Inspector)
// without re-solving — same as clicking the bar on the timeline. Refreshed from render() and at
// the end of drawTimeline() so solved times + the selected highlight stay current.
// Roster view filters — narrow the displayed list only; they never touch the scenario or solver.
let rosterSearch = "";
let rosterSection = ""; // "" = all sections
function renderRoster() {
  const box = $("roster");
  if (!box) return;
  box.innerHTML = "";
  const chipBox = $("roster-chips");
  if (chipBox) chipBox.innerHTML = "";

  if (!scenario.activities.length) {
    box.append(makeEl("p", "No activities yet — add some from Browse Library.", "hint"));
    return;
  }

  // Section filter chips (All + one per section, with counts). Reuses the .lib-chip styling.
  const sections = sectionNames();
  if (rosterSection && !sections.includes(rosterSection)) rosterSection = ""; // its section vanished
  if (chipBox && sections.length > 1) {
    chipBox.append(rosterChip("", "All", scenario.activities.length, !rosterSection));
    for (const sec of sections) {
      const count = scenario.activities.filter(
        (a) => ((a.section && a.section.trim()) || "Ungrouped") === sec
      ).length;
      chipBox.append(rosterChip(sec, sec, count, rosterSection === sec));
    }
  }

  // Apply the section chip + the search text. This filters the DISPLAYED rows only.
  const q = rosterSearch.trim().toLowerCase();
  const rows = scenario.activities.filter((a) => {
    const sec = (a.section && a.section.trim()) || "Ungrouped";
    if (rosterSection && sec !== rosterSection) return false;
    if (!q) return true;
    return (
      String(a.id).toLowerCase().includes(q) ||
      String(a.type || "").toLowerCase().includes(q) ||
      sec.toLowerCase().includes(q)
    );
  });

  if (!rows.length) {
    box.append(makeEl("p", "No activities match this filter.", "hint"));
    return;
  }

  // Group the displayed rows by section (preserving first-seen order), so the flat list reads as
  // labelled, color-coded blocks instead of one long stripe. "Ungrouped" matches the convention used
  // for the chips + filter above.
  const groups = new Map();
  for (const a of rows) {
    const sec = (a.section && a.section.trim()) || "Ungrouped";
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(a);
  }

  for (const [sec, items] of groups) {
    const group = makeEl("div", "", "roster-group");
    // Accent hue derived from the section name (data-driven; no hardcoded section→color map).
    group.style.setProperty("--group-hue", String(sectionHue(sec)));
    const header = makeEl("div", "", "roster-group-head");
    header.append(makeEl("span", sec, "roster-group-name"));
    header.append(makeEl("span", String(items.length), "roster-group-count"));
    group.append(header);

    for (const a of items) {
      const row = document.createElement("div");
      row.className = "roster-row" + (a.id === selectedId ? " selected" : "");
      const sw = makeEl("span", "", "roster-swatch");
      sw.style.background = colorFor(a.id);
      row.append(sw);
      const nameEl = makeEl("span", displayName(a.id), "roster-name"); // match the timeline's labels
      nameEl.title = a.id; // keep the exact id available on hover
      row.append(nameEl);
      row.append(makeEl("span", a.section || "Ungrouped", "roster-section"));
      const s = shownSchedule && shownSchedule.find((x) => sourceId(x.id) === a.id);
      row.append(makeEl("span", s ? `${timeLabel(s.start)}–${timeLabel(s.end)}` : "—", "roster-time"));
      // Same as the timeline bar: re-highlight + open the Inspector, never re-solve.
      onActivate(row, () => {
        selectedId = a.id;
        drawTimeline(shownSchedule, shownStale);
        renderInspector();
        openInspector();
      });
      const x = deleteBtn((e) => {
        e.stopPropagation(); // don't also select the row
        const i = scenario.activities.findIndex((y) => y.id === a.id);
        if (i >= 0) scenario.activities.splice(i, 1);
        if (selectedId === a.id) selectedId = null;
        render();
      });
      x.classList.add("roster-del");
      row.append(x);
      group.append(row);
    }
    box.append(group);
  }
}

// Map a section name to a stable hue (0–359) via a small string hash, so each group gets a distinct
// accent without hardcoding any section→color map or palette (see CLAUDE.md "no hardcoded content").
function sectionHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

// One section filter chip for the roster (label + count; click to set or clear the filter).
function rosterChip(value, label, count, active) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "lib-chip" + (active ? " active" : "");
  chip.append(makeEl("span", label, "lib-chip-label"));
  chip.append(makeEl("span", String(count), "lib-chip-count"));
  chip.onclick = () => {
    rosterSection = rosterSection === value ? "" : value;
    renderRoster();
  };
  return chip;
}

// Clear the roster view filters (used when a different plan is loaded).
function resetRosterFilter() {
  rosterSearch = "";
  rosterSection = "";
  const inp = $("roster-search");
  if (inp) inp.value = "";
}

// ---- library (Browse modal) --------------------------------------------
// A wide, searchable catalog of activity templates loaded from /static/library.json. "+ Add"
// appends a new activity; CP-SAT then places it and the Inspector edits the selected one.
let LIBRARY = [];
// Browse-modal controls (don't re-solve; only "+ Add" changes the plan).
let librarySearch = "";
// Multi-select facets (empty set = no filter on that facet). AND across facets, OR within one.
let librarySections = new Set();
let libraryCategories = new Set();
let libraryDurations = new Set(); // duration band keys: "≤15m" "15–45m" "45–90m" "90m+"
let librarySort = "category"; // default to the banded, grouped-by-category table (P6-style)
let libCollapsedCats = new Set(); // category bands the user has collapsed in the catalog table
let libraryPage = 0; // 0-based page (constraints modal still paginates; the library table scrolls)
let libEditing = null; // the template currently open for inline editing in the catalog table (or null)
const LIB_PAGE = 48;
// User-authored templates ("+ New" in the modal), persisted in localStorage like saved plans.
let customTemplates = [];
const TEMPLATES_KEY = "planner.templates.v1";
// Load the activity templates + type→color map from the data file. On failure both stay empty
// (no hardcoded fallback). colorFor + renderLibraryList read LIBRARY/TYPES at render time, so
// populating them asynchronously is fine.
async function loadLibrary() {
  try {
    const data = await getJSON("/static/library.json");
    LIBRARY = data.templates || [];
    TYPES = data.types || {};
    KINDS = data.kinds || {};   // timeline color-by-kind (icon + match tokens); color is the CSS var
    ABBREV = data.abbrev || {}; // acronym expansion for prettify() labels
  } catch {
    /* leave LIBRARY/TYPES/KINDS/ABBREV empty — no hardcoded fallback data */
  }
}

// Fill the example dropdown from /examples (names + titles). Silent if it fails.
async function loadExamples() {
  try {
    const list = await getJSON("/examples");
    const sel = $("example-select");
    for (const ex of list) {
      const opt = document.createElement("option");
      opt.value = ex.name;
      opt.textContent = ex.title;
      opt.title = ex.description || "";
      sel.append(opt);
    }
  } catch {
    /* leave the dropdown with just its placeholder */
  }
}

// User templates persist like saved plans (loadTabs/saveTabs). On any failure, fall back to [].
function loadTemplates() {
  try {
    const data = JSON.parse(localStorage.getItem(TEMPLATES_KEY));
    customTemplates = Array.isArray(data) ? data : [];
  } catch {
    customTemplates = [];
  }
}
function saveTemplates() {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(customTemplates));
  } catch {
    /* storage unavailable — skip persistence */
  }
}
// User-defined category styling (color + icon): persisted, then merged onto TYPES (over file types).
function loadTypes() {
  try {
    const data = JSON.parse(localStorage.getItem(TYPES_KEY));
    customTypes = data && typeof data === "object" ? data : {};
  } catch {
    customTypes = {};
  }
  Object.assign(TYPES, customTypes);
}
function saveTypes() {
  try {
    localStorage.setItem(TYPES_KEY, JSON.stringify(customTypes));
  } catch {
    /* storage unavailable — skip persistence */
  }
}
// Recently-added templates: a localStorage ring buffer of labels (most-recent first, max 8).
function loadRecents() {
  try {
    const data = JSON.parse(localStorage.getItem(RECENTS_KEY));
    recents = Array.isArray(data) ? data.slice(0, 8) : [];
  } catch {
    recents = [];
  }
}
function pushRecent(label) {
  recents = [label, ...recents.filter((l) => l !== label)].slice(0, 8);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    /* storage unavailable — skip persistence */
  }
}
// The catalog = file (library.json) templates + the user's saved ones. A saved template SHADOWS a
// seed with the same label (case-insensitive), so editing a seed shows ONE row, not a duplicate.
// Keep the SAME element references (no per-item copy) so customTemplates.includes(tpl) still works
// for the "saved" badge / remove / edit-in-place.
function allTemplates() {
  const byKey = new Map();
  for (const t of LIBRARY) byKey.set(String(t.label).toLowerCase(), t);
  for (const t of customTemplates) byKey.set(String(t.label).toLowerCase(), t); // custom wins
  return [...byKey.values()];
}

function openLibrary() {
  $("library-modal").hidden = false;
  renderLibraryList();
  $("library-search").focus();
}
function closeLibrary() {
  $("library-modal").hidden = true;
}

// The Inspector is a popup so the timeline keeps the full width. It opens ONLY on an explicit
// activity selection (a bar or roster-row click), never on the debounced auto-solve redraw.
function openInspector() {
  $("inspector-modal").hidden = false;
  // Move focus into the dialog (first field if the inspector is already rendered, else the close button).
  const m = $("inspector-modal");
  const focusable = m.querySelector("#inspector input, #inspector select, #inspector button") || m.querySelector(".modal-close");
  if (focusable) focusable.focus();
}
function closeInspector() {
  $("inspector-modal").hidden = true;
}

// Export the user's library (saved templates + category colors) as a downloadable JSON file — the
// only backup, since they live only in localStorage (no DB, no cloud).
function exportLibrary() {
  const data = { templates: customTemplates, types: customTypes };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "planner-library.json";
  a.click();
  URL.revokeObjectURL(url);
}
// Import a previously-exported library: merge its templates (by label) + category colors, persist,
// and re-render. Skips malformed entries; never wipes what you already have.
function importLibrary(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { showAlert("Couldn't import — not a valid JSON library file."); return; }
    if (data && Array.isArray(data.templates)) {
      for (const t of data.templates) {
        if (!t || !t.label || !Number.isFinite(t.minutes)) continue;
        const tpl = { label: String(t.label), minutes: t.minutes, category: t.category || null, section: t.section || null };
        const i = customTemplates.findIndex((x) => String(x.label).toLowerCase() === tpl.label.toLowerCase());
        if (i > -1) customTemplates[i] = tpl;
        else customTemplates.push(tpl);
      }
      saveTemplates();
    }
    if (data && data.types && typeof data.types === "object") {
      Object.assign(customTypes, data.types);
      Object.assign(TYPES, customTypes);
      saveTypes();
    }
    renderLibraryList();
  };
  reader.readAsText(file);
}

// A template's duration band (the fixed Duration facet buckets).
const DUR_BANDS = ["≤15m", "15–45m", "45–90m", "90m+"];
function band(m) {
  return m <= 15 ? "≤15m" : m <= 45 ? "15–45m" : m <= 90 ? "45–90m" : "90m+";
}

// Rebuild the facet RAIL (Sections, Category, Duration — each multi-select with live counts) and
// the "+ New" autocomplete datalists, from the data (template sections/categories + TYPES keys).
function rebuildLibraryFilter() {
  const allTpls = allTemplates();
  const secCounts = {}, catCounts = {}, durCounts = {};
  for (const tpl of allTpls) {
    if (tpl.section) secCounts[tpl.section] = (secCounts[tpl.section] || 0) + 1;
    if (tpl.category) catCounts[tpl.category] = (catCounts[tpl.category] || 0) + 1;
    durCounts[band(tpl.minutes)] = (durCounts[band(tpl.minutes)] || 0) + 1;
  }

  const rail = $("library-facets");
  if (rail) {
    rail.innerHTML = "";
    const secs = Object.keys(secCounts).sort((a, b) => a.localeCompare(b));
    if (secs.length) {
      rail.append(facetGroup("Sections", secs.map((s) => libFacet(librarySections, s, s, secCounts[s], null))));
    }
    const cats = Object.keys(catCounts).sort((a, b) => a.localeCompare(b));
    if (cats.length) {
      rail.append(facetGroup("Category", cats.map((c) =>
        libFacet(libraryCategories, c, (TYPES[c] && TYPES[c].label) || c, catCounts[c], TYPES[c] && TYPES[c].color))));
    }
    const bands = DUR_BANDS.filter((b) => durCounts[b]);
    if (bands.length) {
      rail.append(facetGroup("Duration", bands.map((b) => libFacet(libraryDurations, b, b, durCounts[b], null))));
    }
  }

  // "+ New" category autocomplete: all known categories (template cats + TYPES keys).
  const allCats = new Set(Object.keys(catCounts));
  for (const k of Object.keys(TYPES)) allCats.add(k);
  const dl = $("lib-cat-options");
  if (dl) {
    dl.innerHTML = "";
    for (const c of [...allCats].sort((a, b) => a.localeCompare(b))) {
      const o = document.createElement("option");
      o.value = c;
      dl.append(o);
    }
  }
  // section suggestions: distinct sections from templates + the current plan
  const secDl = $("lib-sec-options");
  if (secDl) {
    const secs = new Set();
    for (const tpl of allTpls) if (tpl.section) secs.add(tpl.section);
    for (const a of scenario.activities) if (a.section) secs.add(a.section);
    secDl.innerHTML = "";
    for (const s of [...secs].sort((a, b) => a.localeCompare(b))) {
      const o = document.createElement("option");
      o.value = s;
      secDl.append(o);
    }
  }
}

// A titled facet group in the rail (one of Sections / Category / Duration).
function facetGroup(title, rows) {
  const g = document.createElement("div");
  g.className = "lib-facet-group";
  g.append(makeEl("div", title, "lib-facet-title"));
  const wrap = makeEl("div", "", "lib-facet-rows");
  for (const r of rows) wrap.append(r);
  g.append(wrap);
  return g;
}

// One multi-select facet row: optional color dot + label + count. Click toggles it in `set`.
function libFacet(set, value, label, count, color) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "lib-facet" + (set.has(value) ? " active" : "");
  if (color) {
    const dot = makeEl("span", "", "lib-chip-dot");
    dot.style.background = color;
    chip.append(dot);
  }
  chip.append(makeEl("span", label, "lib-facet-label"));
  chip.append(makeEl("span", String(count), "lib-chip-count"));
  chip.onclick = () => {
    if (set.has(value)) set.delete(value);
    else set.add(value);
    libraryPage = 0; // any filter change jumps back to page 1
    renderLibraryList();
  };
  return chip;
}

// Active-filter pills (removable) + "Clear all". Rendered into #library-pills.
function renderLibraryPills() {
  const box = $("library-pills");
  if (!box) return;
  box.innerHTML = "";
  const active = [];
  for (const s of librarySections) active.push({ set: librarySections, value: s, label: s });
  for (const c of libraryCategories) active.push({ set: libraryCategories, value: c, label: (TYPES[c] && TYPES[c].label) || c });
  for (const d of libraryDurations) active.push({ set: libraryDurations, value: d, label: d });
  for (const f of active) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "lib-pill";
    pill.append(makeEl("span", f.label, "lib-pill-label"));
    pill.append(makeEl("span", "×", "lib-pill-x"));
    pill.onclick = () => { f.set.delete(f.value); libraryPage = 0; renderLibraryList(); };
    box.append(pill);
  }
  if (active.length) {
    const clear = makeEl("button", "Clear all", "lib-clear");
    clear.type = "button";
    clear.onclick = () => {
      librarySections.clear(); libraryCategories.clear(); libraryDurations.clear();
      libraryPage = 0;
      renderLibraryList();
    };
    box.append(clear);
  }
}

// Fill tray (modal footer): how full the current plan is vs the horizon, live as you add. This is
// TOTAL booked work vs the budget (sum of durations), intentionally simpler than the health strip's
// wall-clock span — both `scenario` and planHorizon() are already in scope, so no plumbing.
function renderLibraryTray() {
  const box = $("library-tray");
  if (!box) return;
  box.innerHTML = "";
  const picks = scenario.activities.length;
  const total = scenario.activities.reduce((s, a) => s + (a.duration || 0), 0);
  const horizon = planHorizon();
  const pct = horizon > 0 ? Math.round((100 * total) / horizon) : 0;
  const over = total > horizon;

  box.append(makeEl("span", `${picks} pick${picks === 1 ? "" : "s"}`, "lib-tray-picks"));
  box.append(makeEl("span", `${dur(total)} of ${dur(horizon)}`, "lib-tray-stat"));
  const bar = document.createElement("div");
  bar.className = "lib-tray-bar" + (over ? " over" : "");
  const fill = makeEl("div", "", "lib-tray-fill");
  fill.style.width = Math.min(100, pct) + "%";
  bar.append(fill);
  box.append(bar);
  box.append(makeEl("span", pct + "%", "lib-tray-pct" + (over ? " over" : "")));
}

// Build one template CARD: name, category·section meta, big duration, "×N in plan" badge, "+ Add",
// and (for user-saved templates) a "saved" tag + remove ×. Tinted by its category color.
// The catalog table header: Activity | Category | Section | Duration | In plan | (add).
function libTableHead() {
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const [label, cls] of [["Activity", "lt-name"], ["Category", "lt-cat"], ["Section", "lt-sec"],
    ["Duration", "lt-dur"], ["In plan", "lt-used"], ["", "lt-add"]]) {
    tr.append(makeEl("th", label, cls));
  }
  thead.append(tr);
  return thead;
}

// One catalog ROW (the table form of the old card): a category-colored name, category, section,
// duration, an "× N in plan" count, and the add / saved-remove actions.
// Inline editor for one catalog row: name / category / section / duration inputs + Save/Cancel.
// Editing a SAVED template updates it in place; editing a SEED (library.json) creates a saved copy
// that shadows the seed (see allTemplates), so "editing a library activity" always persists to the
// user's own templates — the read-only file is never mutated. Existing plan activities that were
// already added from this template are independent copies and are NOT changed.
function libEditRowEl(tpl) {
  const tr = document.createElement("tr");
  tr.className = "lt-row lt-row-editing";
  tr.style.setProperty("--cat", (TYPES[tpl.category] && TYPES[tpl.category].color) || "var(--muted)");

  const mkText = (val, ph, list) => {
    const i = makeEl("input", "", "select select-sm");
    i.type = "text";
    i.value = val == null ? "" : String(val);
    i.placeholder = ph;
    if (list) i.setAttribute("list", list);
    return i;
  };
  const nameIn = mkText(tpl.label, "Name…");
  const catIn = mkText(tpl.category, "Category", "lib-cat-options");
  const secIn = mkText(tpl.section, "Section", "lib-sec-options");
  const durIn = makeEl("input", "", "select select-sm");
  durIn.type = "number"; durIn.min = "1"; durIn.step = "1"; durIn.value = String(tpl.minutes);

  const nameTd = makeEl("td", "", "lt-name"); nameTd.append(nameIn);
  const catTd = makeEl("td", "", "lt-cat"); catTd.append(catIn);
  const secTd = makeEl("td", "", "lt-sec"); secTd.append(secIn);
  const durTd = makeEl("td", "", "lt-dur"); durTd.append(durIn);
  tr.append(nameTd, catTd, secTd, durTd, makeEl("td", "", "lt-used"));

  const save = () => {
    const label = nameIn.value.trim();
    const minutes = parseInt(durIn.value, 10);
    if (!label) { nameIn.focus(); return; }
    if (!Number.isInteger(minutes) || minutes < 1) { durIn.focus(); return; }
    const category = catIn.value.trim() || null;
    const section = secIn.value.trim() || null;
    if (customTemplates.includes(tpl)) {
      Object.assign(tpl, { label, minutes, category, section }); // edit the saved template in place
    } else {
      customTemplates.push({ label, minutes, category, section }); // seed -> a saved copy that shadows it
    }
    saveTemplates();
    libEditing = null;
    renderLibraryList();
    flash(`Saved “${label}”`);
  };
  const cancel = () => { libEditing = null; renderLibraryList(); };

  const actTd = makeEl("td", "", "lt-add");
  const saveBtn = makeEl("button", "Save", "btn btn-sm btn-primary"); saveBtn.type = "button"; saveBtn.onclick = save;
  const cancelBtn = makeEl("button", "Cancel", "btn btn-sm"); cancelBtn.type = "button"; cancelBtn.onclick = cancel;
  actTd.append(saveBtn, cancelBtn);
  tr.append(actTd);

  // Enter saves, Esc cancels — quick keyboard editing.
  for (const el of [nameIn, catIn, secIn, durIn]) {
    el.onkeydown = (e) => {
      // stop Enter/Esc from bubbling to the global handlers (Esc would close the whole Library modal).
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); save(); }
      else if (e.key === "Escape") { e.stopPropagation(); cancel(); }
    };
  }
  return tr;
}

function libRowEl(tpl) {
  if (libEditing === tpl) return libEditRowEl(tpl); // this row is open for editing -> show the editor
  const tr = document.createElement("tr");
  tr.className = "lt-row";
  tr.style.setProperty("--cat", (TYPES[tpl.category] && TYPES[tpl.category].color) || "var(--muted)");

  const nameTd = makeEl("td", "", "lt-name");
  nameTd.append(makeEl("span", "", "lt-dot"));
  nameTd.append(makeEl("span", tpl.label, "lt-name-txt"));
  if (customTemplates.includes(tpl)) nameTd.append(makeEl("span", "saved", "lib-row-saved"));
  tr.append(nameTd);

  tr.append(makeEl("td", (TYPES[tpl.category] && TYPES[tpl.category].label) || tpl.category || "—", "lt-cat"));
  tr.append(makeEl("td", tpl.section || "—", "lt-sec"));
  tr.append(makeEl("td", dur(tpl.minutes), "lt-dur"));

  // "× N in plan": how many activities in the current plan came from this template (matched by id base).
  const base = slug(tpl.label);
  const used = scenario.activities.filter((a) => a.id === base || a.id.startsWith(base + "_")).length;
  tr.append(makeEl("td", used > 0 ? "×" + used : "", "lt-used"));

  const actTd = makeEl("td", "", "lt-add");
  const add = makeEl("button", "+ Add", "btn btn-sm lt-add-btn");
  add.type = "button";
  add.onclick = () => {
    scenario.activities.push({
      id: uniqueActivityId(slug(tpl.label)),
      duration: tpl.minutes,
      section: tpl.section || null,
      type: tpl.category,
    });
    pushRecent(tpl.label);
    render(); // roster + (debounced) timeline update; modal stays open
    renderLibraryList(); // refresh the "in plan" counts
    flash(`Added “${tpl.label}”`);
  };
  actTd.append(add);
  // Edit any activity (seed or saved). Editing a seed saves an editable copy that shadows it.
  const edit = makeEl("button", "Edit", "btn btn-sm lt-edit-btn");
  edit.type = "button";
  edit.title = "Edit this activity";
  edit.onclick = () => { libEditing = tpl; renderLibraryList(); };
  actTd.append(edit);
  // User-saved templates get a × to remove; seed (library.json) rows don't.
  if (customTemplates.includes(tpl)) {
    const rm = deleteBtn(() => {
      const i = customTemplates.indexOf(tpl);
      if (i > -1) customTemplates.splice(i, 1);
      saveTemplates();
      renderLibraryList();
    });
    rm.title = "Remove saved template";
    actTd.append(rm);
  }
  tr.append(actTd);
  return tr;
}

// A P6-style group band: a full-width colored header for one category, with a caret, its name, the
// activity count, and their total duration. Click (or Enter/Space) to collapse/expand the group.
function libBandRow(cat, items) {
  const tr = document.createElement("tr");
  tr.className = "lt-band";
  tr.style.setProperty("--cat", (TYPES[cat] && TYPES[cat].color) || "var(--muted)");
  const open = !libCollapsedCats.has(cat);
  const total = items.reduce((s, t) => s + (t.minutes || 0), 0);

  const td = document.createElement("td");
  td.colSpan = 6;
  const inner = makeEl("div", "", "lt-band-inner");
  inner.append(makeEl("span", open ? "▾" : "▸", "lt-band-caret"));
  inner.append(makeEl("span", (TYPES[cat] && TYPES[cat].label) || cat || "Uncategorized", "lt-band-name"));
  inner.append(makeEl("span", String(items.length), "lt-band-count"));
  inner.append(makeEl("span", dur(total), "lt-band-dur"));
  td.append(inner);
  tr.append(td);

  onActivate(tr, () => {
    if (libCollapsedCats.has(cat)) libCollapsedCats.delete(cat);
    else libCollapsedCats.add(cat);
    renderLibraryList();
  });
  return tr;
}

// Refresh the whole modal: rail facets + active pills + sort state, then draw the filtered/sorted
// templates as a TABLE. Sort = "category" groups the rows into collapsible P6-style colored bands;
// "name"/"duration" is a flat sorted table. The table scrolls, so there's no pager.
function renderLibraryList() {
  rebuildLibraryFilter();
  renderLibraryPills();
  renderLibraryTray();
  for (const b of document.querySelectorAll(".lib-sort-btn")) b.classList.toggle("active", b.dataset.sort === librarySort);

  const box = $("library-list");
  const count = $("library-count");
  box.innerHTML = "";
  $("library-pager").innerHTML = "";

  if (!allTemplates().length) {
    if (count) count.textContent = "";
    box.append(makeEl("p", "No templates yet — use “+ New” to create one.", "hint"));
    return;
  }

  const rows = filteredTemplates();
  if (!rows.length) {
    if (count) count.textContent = "0 results";
    box.append(makeEl("p", "No activities match these filters. Try clearing one.", "hint"));
    return;
  }
  if (count) count.textContent = `Showing ${rows.length} of ${allTemplates().length}`;

  const table = document.createElement("table");
  table.className = "lib-table";
  table.append(libTableHead());
  const tbody = document.createElement("tbody");
  if (librarySort === "category") {
    // Group rows into category bands, preserving the sorted order (category, then name).
    const groups = new Map();
    for (const tpl of rows) {
      const key = tpl.category || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tpl);
    }
    for (const [cat, items] of groups) {
      tbody.append(libBandRow(cat, items));
      if (!libCollapsedCats.has(cat)) for (const tpl of items) tbody.append(libRowEl(tpl));
    }
  } else {
    for (const tpl of rows) tbody.append(libRowEl(tpl));
  }
  table.append(tbody);
  box.append(table);
}

// Apply the search text + the three facet sets, then sort. AND across facet groups, OR within one.
function filteredTemplates() {
  const q = librarySearch.trim().toLowerCase();
  const rows = allTemplates().filter((tpl) => {
    if (librarySections.size && !librarySections.has(tpl.section)) return false;
    if (libraryCategories.size && !libraryCategories.has(tpl.category)) return false;
    if (libraryDurations.size && !libraryDurations.has(band(tpl.minutes))) return false;
    if (!q) return true;
    return String(tpl.label || "").toLowerCase().includes(q)
        || String(tpl.category || "").toLowerCase().includes(q)
        || String(tpl.section || "").toLowerCase().includes(q);
  });
  rows.sort((a, b) => {
    if (librarySort === "duration") return (a.minutes || 0) - (b.minutes || 0);
    if (librarySort === "category")
      return String(a.category || "").localeCompare(String(b.category || ""))
          || String(a.label || "").localeCompare(String(b.label || ""));
    return String(a.label || "").localeCompare(String(b.label || ""));
  });
  return rows;
}

// Numbered pager: ‹ Prev  1 2 [3] … N  Next ›. Renders nothing when there's only one page.
function renderLibraryPager(pageCount) {
  const box = $("library-pager");
  if (!box || pageCount <= 1) return;
  const pageBtn = (label, page, opts = {}) => {
    const b = makeEl("button", label, "lib-page" + (opts.active ? " active" : ""));
    b.type = "button";
    if (opts.disabled) b.disabled = true;
    else b.onclick = () => { libraryPage = page; renderLibraryList(); };
    return b;
  };
  box.append(pageBtn("‹ Prev", libraryPage - 1, { disabled: libraryPage <= 0 }));
  for (const p of pageWindow(libraryPage, pageCount)) {
    if (p === "…") box.append(makeEl("span", "…", "lib-page-gap"));
    else box.append(pageBtn(String(p + 1), p, { active: p === libraryPage }));
  }
  box.append(pageBtn("Next ›", libraryPage + 1, { disabled: libraryPage >= pageCount - 1 }));
}

// Which page indices to show: first, last, and current±1, with "…" gaps between jumps.
function pageWindow(cur, pageCount) {
  const keep = new Set([0, pageCount - 1, cur, cur - 1, cur + 1]);
  const ps = [...keep].filter((p) => p >= 0 && p < pageCount).sort((a, b) => a - b);
  const out = [];
  let prev = -1;
  for (const p of ps) {
    if (p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}
// "Sleep 8h" -> "sleep_8h"-ish: lowercase, non-word -> "_", trimmed; fallback "activity".
function slug(label) {
  const s = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "activity";
}

// Inspector (right panel): edits the activity you clicked on the timeline.
// If nothing is selected (or the id no longer exists) it just shows a hint.
// Each field edit changes the activity and re-solves.
function renderInspector() {
  const box = $("inspector");
  if (!box) return;
  box.innerHTML = "";

  const act = selectedId && scenario.activities.find((a) => a.id === selectedId);
  if (!act) {
    if (selectedId) selectedId = null; // clear a dangling selection (e.g. deleted activity)
    closeInspector(); // its activity is gone — don't leave an empty popup open
    box.append(makeEl("p", "Click an activity on the timeline to inspect it.", "insp-hint"));
    return;
  }

  // id (editable text). It re-solves on every keystroke. An empty id would break the
  // schedule, so we ignore a blank and keep the old id.
  const idField = labeledField("id", textInput(act.id, (v) => {
    const next = v.trim();
    // Ignore blank, and reject an id already used by ANOTHER activity — a collision would make two
    // activities share an id (one bar drawn for two, and constraints would point at the wrong one).
    if (next && !scenario.activities.some((a) => a !== act && a.id === next)) {
      act.id = next;
      selectedId = next;
    }
  }, "activity id"));
  box.append(idField);

  // duration (minutes) + section (blank = Ungrouped) — both mutate + re-solve.
  box.append(numField("duration (min)", act.duration, (v) => {
    if (Number.isInteger(v) && v >= 1) act.duration = v; // reject 0 / negative / blank, like the Library
  }));
  box.append(textField("section", act.section || "", (v) => (act.section = v.trim() || null)));

  // type: placeholder select (only "None" for now; later phases add real types).
  const typeOpts = [{ value: "", label: "None" }].concat(
    Object.entries(TYPES).map(([v, t]) => ({ value: v, label: t.label }))
  );
  box.append(selectField("type", act.type || "", typeOpts, (v) => (act.type = v || null)));

  // assignee: a free-text owner you set (worker / friend / crew). Display-only — the timeline can
  // group lanes by it (Group by: Assignee). Autocompletes from assignees already used in the plan.
  box.append(assigneeField("assignee", act.assignee || "", assigneeValues(), (v) => (act.assignee = v.trim() || null)));

  // Optional read-only solved start–end from the schedule currently drawn.
  const solved = shownSchedule && shownSchedule.find((s) => sourceId(s.id) === act.id);
  if (solved) box.append(makeEl("div", `Scheduled ${timeLabel(solved.start)}–${timeLabel(solved.end)}`, "insp-solved"));

  const del = deleteBtn(() => {
    const i = scenario.activities.findIndex((a) => a.id === act.id);
    if (i >= 0) scenario.activities.splice(i, 1);
    selectedId = null;
    render();
  });
  del.classList.add("insp-delete");
  del.textContent = "Delete activity";
  box.append(del);
}
// A label-over-input row wrapper for an already-built input element.
function labeledField(label, inputEl) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(makeEl("span", label, "field-lbl"));
  wrap.append(inputEl);
  return wrap;
}

// Constraints manager state: a search box, a multi-select TYPE filter, and the current card page.
let conSearch = "";
let conTypes = new Set();
let constraintsPage = 0; // retained: a couple of handlers still reset it, but the constraints table scrolls (no paging)

const CON_TYPE_LABEL = {
  time_window: "Time window", no_overlap: "No overlap", precedence: "Precedence",
  sequence: "Sequence", conditional: "Conditional", working_window: "Working window",
  section_budget: "Section budget", overlap: "Overlap",
  time_lag: "Time lag", min_separation: "Min separation",
};
function constraintTypeLabel(t) { return CON_TYPE_LABEL[t] || t; }
// Type -> tint color (a CSS var string), used as the card's --cat border/wash. Mirrors the old
// con-dot colors so each type reads the same as in the rest of the UI.
const CON_TYPE_COLOR = {
  time_window: "var(--accent)", working_window: "var(--accent)", precedence: "var(--ok)",
  sequence: "var(--warn)", conditional: "var(--violet)", no_overlap: "var(--muted)",
  section_budget: "var(--warn)", overlap: "var(--violet)",
  time_lag: "var(--ok)", min_separation: "var(--violet)",
};
function constraintTypeColor(t) { return CON_TYPE_COLOR[t] || "var(--muted)"; }

// Total busy minutes currently in a section: sum of its activities' durations, counting a recurring
// activity once per day of the solved horizon (matching how the solver sums a section_budget). A
// quick estimate for the budget UI — the solver is the source of truth.
function sectionBusyMinutes(section) {
  if (!section) return 0;
  const days = Math.max(1, Math.floor((solvedHorizon || DAY) / DAY));
  return scenario.activities
    .filter((a) => (a.section && a.section.trim()) === section)
    .reduce((s, a) => s + (Number(a.duration) || 0) * (a.recurs_daily ? days : 1), 0);
}

// One-line summary shown on a collapsed row, so 200 constraints are scannable without expanding.
function constraintSummary(c) {
  if (c.type === "time_window") {
    const w = [c.earliest && "≥ " + c.earliest, c.latest_end && "≤ " + c.latest_end].filter(Boolean).join(", ");
    const d = c.day != null ? " · Day " + (c.day + 1) : "";
    return (c.activity || "—") + (w ? " · " + w : "") + d;
  }
  if (c.type === "overlap") {
    return (c.outer || "—") + (c.mode === "overlaps" ? " ∩ " : " ⊇ ") + (c.inner || "—");
  }
  if (c.type === "no_overlap") {
    return "no overlap · " + (c.activities === "all" || c.activities == null ? "all activities" : (c.activities.length + " activities"));
  }
  if (c.type === "precedence") return (c.before || "—") + " → " + (c.after || "—");
  if (c.type === "sequence") return (c.activities || []).join(" → ") || "—";
  if (c.type === "conditional") {
    const w = (c.when || {}).activity, t = ((c.then || {}).set_duration || {}).activity;
    return "when " + (w || "—") + " → then " + (t || "—");
  }
  if (c.type === "working_window") {
    return (c.section || "all") + " · " + c.open + "–" + c.close + " · " + (c.days === "all" ? "every day" : "days " + (c.days || []).join(","));
  }
  if (c.type === "section_budget") {
    return (c.section || "—") + " · ≤ " + dur(c.max_minutes || 0);
  }
  if (c.type === "time_lag") {
    // e.g. "EVA prep → EVA: 0–0 min (end→start)" — show whatever bound(s) are set.
    const lo = c.min_lag, hi = c.max_lag;
    let range;
    if (lo != null && hi != null) range = lo === hi ? String(lo) : lo + "–" + hi;
    else if (lo != null) range = "≥ " + lo;
    else if (hi != null) range = "≤ " + hi;
    else range = "any"; // neither set yet (invalid until one is)
    const anchors = (c.from_anchor || "end") + "→" + (c.to_anchor || "start");
    const shift = c.day_shift ? ` +${c.day_shift}d` : "";
    return (c.from_id || "—") + " → " + (c.to_id || "—") + ": " + range + " min (" + anchors + ")" + shift;
  }
  if (c.type === "min_separation") {
    // e.g. "exercise ≥30 min from lunch"
    const shift = c.day_shift ? ` +${c.day_shift}d` : "";
    return (c.a || "—") + " ≥ " + (c.gap || 0) + " min from " + (c.b || "—") + shift;
  }
  return c.type;
}

// One TYPE filter chip (All + one per type, with counts). Reuses the .lib-chip styling.
function conChip(value, label, count, active) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "lib-chip" + (active ? " active" : "");
  chip.append(makeEl("span", label, "lib-chip-label"));
  chip.append(makeEl("span", String(count), "lib-chip-count"));
  chip.onclick = () => {
    if (value === "") conTypes.clear();
    else if (conTypes.has(value)) conTypes.delete(value);
    else conTypes.add(value);
    constraintsPage = 0; // a filter change jumps back to page 1
    renderConstraints();
  };
  return chip;
}

// The constraints table header — mirrors libTableHead so the two modals look identical.
function conTableHead() {
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const [label, cls] of [["Rule", "lt-name"], ["Type", "con-type"], ["Pri", "con-pri"], ["Details", "con-sum"],
    ["On", "con-on"], ["", "lt-add"]]) {
    tr.append(makeEl("th", label, cls));
  }
  thead.append(tr);
  return thead;
}

// Build one constraint ROW for the table (same look as the Library rows): the rule label with the
// type-colored left edge + dot, the type, a plain-English summary, an enable toggle, then Edit +
// delete. Editing happens in the add-constraint popup (EDIT mode).
function conRowEl(c) {
  const relaxed = relaxedIds.has(c.id);
  const tr = document.createElement("tr");
  tr.className = "lt-row con-row" + (c.enabled === false ? " off" : "") + (relaxed ? " relaxed" : "");
  tr.style.setProperty("--cat", constraintTypeColor(c.type));
  if (c.rationale) tr.title = c.rationale; // hover shows the WHY

  const nameTd = makeEl("td", "", "lt-name");
  nameTd.append(makeEl("span", "", "lt-dot"));
  nameTd.append(makeEl("span", c.label || constraintTypeLabel(c.type), "lt-name-txt"));
  tr.append(nameTd);

  tr.append(makeEl("td", constraintTypeLabel(c.type), "con-type"));
  const priTd = makeEl("td", "", "con-pri");
  priTd.append(priorityBadge(c.priority));
  if (relaxed) priTd.append(makeEl("span", "RELAXED", "pri-relaxed"));
  tr.append(priTd);
  tr.append(makeEl("td", constraintSummary(c), "con-sum"));

  // Enable toggle: flips c.enabled + re-solves, but must NOT open the editor.
  const onTd = makeEl("td", "", "con-on");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = c.enabled !== false;
  cb.title = "Enabled";
  cb.setAttribute("aria-label", "enabled");
  cb.onchange = () => {
    c.enabled = cb.checked;
    if (cb.checked) relaxedIds.delete(c.id); // re-enabling clears the relaxed mark
    tr.classList.toggle("off", !cb.checked);
    tr.classList.toggle("relaxed", relaxedIds.has(c.id));
    scheduleSolve();
  };
  onTd.append(cb);
  tr.append(onTd);

  const actTd = makeEl("td", "", "lt-add");
  const edit = makeEl("button", "Edit", "btn btn-sm con-card-edit");
  edit.type = "button";
  edit.onclick = (e) => { e.stopPropagation(); openEditConstraintModal(c); };
  actTd.append(edit);
  const del = deleteBtn((e) => {
    e.stopPropagation();
    const i = scenario.constraints.indexOf(c);
    if (i >= 0) scenario.constraints.splice(i, 1);
    render();
  });
  actTd.append(del);
  tr.append(actTd);
  return tr;
}

// The constraints list as a scrolling TABLE (same look as Browse Library): filtered by search + type
// chips, one row per rule, edited in the add-constraint popup. The table scrolls, so there's no pager.
function renderConstraints() {
  const box = $("constraints");
  if (!box) return;
  box.innerHTML = "";
  const cons = scenario.constraints;
  // Drop stale relaxed marks (the rule was re-enabled or deleted).
  for (const id of [...relaxedIds]) {
    const rc = cons.find((x) => x.id === id);
    if (!rc || rc.enabled !== false) relaxedIds.delete(id);
  }

  // Type filter chips (only when there's more than one type to choose between).
  const chipBox = $("con-chips");
  if (chipBox) {
    chipBox.innerHTML = "";
    const counts = {};
    for (const c of cons) counts[c.type] = (counts[c.type] || 0) + 1;
    const types = Object.keys(counts).sort();
    if (types.length > 1) {
      chipBox.append(conChip("", "All", cons.length, !conTypes.size));
      for (const t of types) chipBox.append(conChip(t, constraintTypeLabel(t), counts[t], conTypes.has(t)));
    }
  }

  // Filter by the type chips + the search text (label / type / summary).
  const q = conSearch.trim().toLowerCase();
  const rows = cons.filter((c) => {
    if (conTypes.size && !conTypes.has(c.type)) return false;
    if (!q) return true;
    return (c.label || "").toLowerCase().includes(q)
      || c.type.includes(q)
      || constraintSummary(c).toLowerCase().includes(q);
  });

  const pager = $("constraints-pager");
  if (pager) pager.innerHTML = ""; // the table scrolls; keep the pager slot empty (mirrors the library)

  if (!cons.length) box.append(makeEl("p", "No constraints yet — use “+ Constraint” to add one.", "hint"));
  else if (!rows.length) box.append(makeEl("p", "No constraints match this filter.", "hint"));
  else {
    const table = document.createElement("table");
    table.className = "lib-table";
    table.append(conTableHead());
    const tbody = document.createElement("tbody");
    for (const c of rows) tbody.append(conRowEl(c));
    table.append(tbody);
    box.append(table);
  }

  const btn = $("open-constraints");
  if (btn) btn.textContent = `⚙ Manage constraints (${cons.length})`;
}

// Constraint PRIORITY (1 = hard/inviolable … 5 = casual preference). The live solve treats every rule
// as hard; priority only tells the on-demand "Auto-relax" which rules it MAY drop (never P1) to fit.
const PRIORITY_OPTS = [
  { value: "1", label: "P1 · Physical / hard (never dropped)" },
  { value: "2", label: "P2 · Critical / safety" },
  { value: "3", label: "P3 · Risk" },
  { value: "4", label: "P4 · Important" },
  { value: "5", label: "P5 · Preference (dropped first)" },
];
// coarse severity class for the badge colour (paired with the "P#" label, never colour alone).
function priorityTier(p) { return (p || 1) <= 1 ? "hard" : (p || 1) <= 3 ? "warn" : "info"; }
function priorityBadge(p) {
  const b = makeEl("span", "P" + (p || 1), "pri-badge pri-" + priorityTier(p));
  const opt = PRIORITY_OPTS[(p || 1) - 1];
  if (opt) b.title = opt.label;
  return b;
}
// Constraints the last "Auto-relax" turned off to make the plan fit (shown red until re-enabled).
let relaxedIds = new Set();

function constraintFields(c) {
  const f = [];
  // Priority + rationale are shared by EVERY constraint (base fields) — show them first.
  f.push(selectField("priority", String(c.priority || 3), PRIORITY_OPTS, (v) => (c.priority = parseInt(v, 10) || 3)));
  f.push(textField("rationale (why it matters)", c.rationale || "", (v) => (c.rationale = v)));
  if (c.type === "time_window") {
    f.push(activitySelect("activity", c.activity, (v) => (c.activity = v)));
    f.push(textField("earliest (HH:MM)", c.earliest || "", (v) => (c.earliest = v || null)));
    f.push(textField("latest end (HH:MM)", c.latest_end || "", (v) => (c.latest_end = v || null)));
    // Which mission day the clock falls on. Stored 0-based (0 = Day 1); blank = Day 1.
    f.push(textField("day (0 = Day 1, blank = Day 1)", c.day == null ? "" : String(c.day),
      (v) => { const n = parseInt(v, 10); c.day = v.trim() === "" || !Number.isFinite(n) ? null : Math.max(0, n); }));
  } else if (c.type === "precedence") {
    f.push(activitySelect("before", c.before, (v) => (c.before = v)));
    f.push(activitySelect("after", c.after, (v) => (c.after = v)));
  } else if (c.type === "overlap") {
    f.push(activitySelect("outer (covers)", c.outer, (v) => (c.outer = v)));
    f.push(activitySelect("inner (covered)", c.inner, (v) => (c.inner = v)));
    f.push(selectField("mode", c.mode || "contains", [
      { value: "contains", label: "outer fully covers inner (during)" },
      { value: "overlaps", label: "intervals merely overlap" },
    ], (v) => (c.mode = v)));
  } else if (c.type === "time_lag") {
    // lag = (to_anchor of to) − (from_anchor of from), bounded by [min_lag, max_lag].
    f.push(activitySelect("from", c.from_id, (v) => (c.from_id = v)));
    f.push(activitySelect("to", c.to_id, (v) => (c.to_id = v)));
    f.push(selectField("from anchor", c.from_anchor || "end", [
      { value: "start", label: "start of from" },
      { value: "end", label: "end of from" },
    ], (v) => (c.from_anchor = v)));
    f.push(selectField("to anchor", c.to_anchor || "start", [
      { value: "start", label: "start of to" },
      { value: "end", label: "end of to" },
    ], (v) => (c.to_anchor = v)));
    // Blank = no bound (null); at least one of min/max must be set for the rule to do anything.
    f.push(textField("min lag (min, blank = none)", c.min_lag == null ? "" : String(c.min_lag),
      (v) => { const n = parseInt(v, 10); c.min_lag = v.trim() === "" || !Number.isFinite(n) ? null : n; }));
    f.push(textField("max lag (min, blank = none)", c.max_lag == null ? "" : String(c.max_lag),
      (v) => { const n = parseInt(v, 10); c.max_lag = v.trim() === "" || !Number.isFinite(n) ? null : n; }));
    f.push(textField("day shift (0 = same day)", c.day_shift == null ? "0" : String(c.day_shift),
      (v) => { const n = parseInt(v, 10); c.day_shift = Number.isFinite(n) ? n : 0; }));
    if (c.min_lag == null && c.max_lag == null)
      f.push(makeEl("p", "Set at least one of min/max lag for this rule to take effect.", "hint"));
  } else if (c.type === "min_separation") {
    // Keep a and b at least `gap` minutes apart, in either order (a real buffer).
    f.push(activitySelect("activity A", c.a, (v) => (c.a = v)));
    f.push(activitySelect("activity B", c.b, (v) => (c.b = v)));
    f.push(numField("gap (minutes apart)", c.gap, (v) => { if (Number.isFinite(v) && v > 0) c.gap = v; }));
    f.push(textField("day shift (0 = same day)", c.day_shift == null ? "0" : String(c.day_shift),
      (v) => { const n = parseInt(v, 10); c.day_shift = Number.isFinite(n) ? n : 0; }));
  } else if (c.type === "no_overlap") {
    const isAll = c.activities === "all" || c.activities == null;
    f.push(selectField("applies to", isAll ? "all" : "specific", [
      { value: "all", label: "All activities" },
      { value: "specific", label: "Specific activities" },
    ], (v) => {
      c.activities = v === "all" ? "all" : (Array.isArray(c.activities) ? c.activities : []);
      render();
    }));
    if (!isAll) f.push(activityChecklist(c.activities, (next) => (c.activities = next)));
  } else if (c.type === "sequence") {
    if (!Array.isArray(c.activities)) c.activities = [];
    f.push(sequenceEditor(c.activities, (next) => (c.activities = next)));
  } else if (c.type === "conditional") {
    if (!c.when) c.when = { activity: "", present: false };
    if (!c.then) c.then = { set_duration: { activity: "", factor: 2 } };
    if (!c.then.set_duration) c.then.set_duration = { activity: "", factor: 2 };
    const when = c.when;
    const sd = c.then.set_duration;
    f.push(activitySelect("if activity", when.activity, (v) => (when.activity = v)));
    f.push(selectField("is", String(when.present === true), [
      { value: "false", label: "not scheduled" },
      { value: "true", label: "scheduled" },
    ], (v) => (when.present = v === "true")));
    f.push(activitySelect("then scale", sd.activity, (v) => (sd.activity = v)));
    f.push(numField("× factor", sd.factor, (v) => (sd.factor = v)));
  } else if (c.type === "working_window") {
    // Target: "All" or one of the sections currently in the plan.
    const secs = [...new Set(
      scenario.activities.map((a) => a.section && a.section.trim()).filter(Boolean)
    )];
    f.push(selectField("applies to", c.section || "all", [
      { value: "all", label: "All activities" },
      ...secs.map((s) => ({ value: s, label: "Section: " + s })),
    ], (v) => { c.section = v; render(); }));
    f.push(textField("open (HH:MM)", c.open || "", (v) => (c.open = v)));
    f.push(textField("close (HH:MM)", c.close || "", (v) => (c.close = v)));
  } else if (c.type === "section_budget") {
    const secs = [...new Set(
      scenario.activities.map((a) => a.section && a.section.trim()).filter(Boolean)
    )];
    f.push(selectField("section", c.section || (secs[0] || ""),
      secs.length ? secs.map((s) => ({ value: s, label: "Section: " + s }))
                  : [{ value: "", label: "(no sections yet)" }],
      (v) => { c.section = v; render(); }));
    f.push(numField("max minutes", c.max_minutes,
      (v) => { if (Number.isFinite(v) && v > 0) c.max_minutes = v; }));
    // Live usage hint so the user picks a sensible cap (and sees when it's already over).
    if (c.section) {
      const used = sectionBusyMinutes(c.section);
      const over = Number.isFinite(c.max_minutes) && used > c.max_minutes;
      f.push(makeEl("p",
        (over ? "⚠ " : "") + `${c.section} currently uses ${dur(used)}`
          + (over ? ` — over the ${dur(c.max_minutes)} cap` : ""),
        "hint"));
    }
  }
  return f;
}

// ---- result / Gantt -----------------------------------------------------
// Take the solver's result and update the status pill, the message banner,
// the health strip, and the timeline. Branches on the status it returned.
function renderResult(result) {
  $("result").hidden = false;
  const status = result.status || "?";
  const pill = $("status");
  pill.textContent = status;
  pill.className =
    "pill " + (status === "OPTIMAL" || status === "FEASIBLE" ? "pill-ok" : status === "INFEASIBLE" ? "pill-bad" : "pill-warn");

  const banner = $("banner");
  banner.hidden = true;
  banner.textContent = "";
  // Every new result clears any open "why infeasible" explanation and invalidates any in-flight one.
  resultSeq++;
  const explain = $("explain");
  if (explain) { explain.hidden = true; explain.innerHTML = ""; }

  if (status === "OPTIMAL" || status === "FEASIBLE") {
    solvedHorizon = result.horizon || DAY; // size the timeline to what the solver used
    if (result.schedule && result.schedule.length) {
      lastFeasibleSchedule = result.schedule;
      renderHealth(status, result.schedule, false);
      // Auto-fit: a 2-day mission on a 39-day horizon draws as unreadable slivers.
      // If the work uses under a quarter of the axis and the user hasn't zoomed,
      // zoom in so the bars are legible (Fit still resets to 1).
      if (zoomX === 1) {
        const lo = Math.min(...result.schedule.map((s) => s.start));
        const hi = Math.max(...result.schedule.map((s) => s.end));
        const span = Math.max(1, hi - lo);
        if (span / solvedHorizon < 0.25) {
          zoomX = Math.min(12, Math.max(1, Math.round((solvedHorizon / span) * 0.8 * 2) / 2));
          $("zoom-x").value = String(Math.min(12, zoomX));
        }
      }
      drawTimeline(result.schedule, false);
    } else {
      banner.hidden = false;
      banner.className = "banner";
      banner.textContent = "Solved, but there are no activities to show.";
      renderHealth(status, null, false);
      $("timeline").innerHTML = "";
    }
    return;
  }
  if (status === "INFEASIBLE") {
    banner.hidden = false;
    banner.className = "banner banner-bad";
    banner.textContent = "";
    banner.append(makeEl("span",
      lastFeasibleSchedule
        ? "That change broke the schedule — nothing fits all the rules now."
        : "No schedule satisfies all enabled constraints.",
      "banner-msg"));
    // On-demand explainer: ask the solver which rules actually conflict (kept off the hot path).
    const why = makeEl("button", "🔍 Which rules conflict?", "btn btn-sm banner-why");
    why.type = "button";
    why.onclick = () => explainInfeasible(why);
    banner.append(why);
    const relaxBtn = makeEl("button", "⚖ Auto-relax lowest priority", "btn btn-sm banner-why");
    relaxBtn.type = "button";
    relaxBtn.title = "Drop the lowest-priority conflicting rules (never P1) until the plan fits";
    relaxBtn.onclick = () => autoRelax(relaxBtn);
    banner.append(relaxBtn);
    if (lastFeasibleSchedule) {
      renderHealth(status, lastFeasibleSchedule, true);
      drawTimeline(lastFeasibleSchedule, true);
    } else {
      renderHealth(status, null, false);
      showTimelinePlaceholder("No arrangement satisfies these rules yet — open “Manage constraints” to loosen a rule, or use “Which rules conflict?”.");
    }
    return;
  }
  banner.hidden = false;
  banner.className = "banner banner-warn";
  banner.textContent = "Solver returned: " + status;
  renderHealth(status, null, false);
  $("timeline").innerHTML = "";
}

// Ask /explain which enabled rules actually conflict (a MINIMAL set — turn off any one to resolve
// it) and list them with a one-click "Disable". On-demand so the live solve loop stays fast.
async function explainInfeasible(btn) {
  const panel = $("explain");
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = "";
  panel.append(makeEl("p", "Checking which rules conflict…", "explain-status"));
  if (btn) btn.disabled = true;
  const seq = resultSeq; // if a newer solve lands while we await, this answer is stale — bail.
  let result;
  try {
    result = await post("/explain", solvePayload());
  } catch (err) {
    if (seq !== resultSeq) return;
    panel.innerHTML = "";
    panel.append(makeEl("p", err.message, "explain-status"));
    return;
  } finally {
    if (btn) btn.disabled = false;
  }
  if (seq !== resultSeq) return; // the plan was re-solved while we waited; discard this explanation
  panel.innerHTML = "";
  if (result.structural) {
    panel.append(makeEl("p",
      "No single rule is the cause — even with every rule off, the activities don't fit. There's "
      + "too much work for the planning window, or a section is over-packed. Try a longer horizon, "
      + "fewer/shorter activities, or a higher section budget.",
      "explain-status"));
    return;
  }
  const ids = result.conflict_ids || [];
  if (!ids.length) {
    panel.append(makeEl("p", "It looks like the plan solves now — try Solve again.", "explain-status"));
    return;
  }
  panel.append(makeEl("p",
    ids.length === 1
      ? "This rule can't be satisfied with the rest — turn it off to resolve the conflict:"
      : `These ${ids.length} rules can't all hold at once — turn off any one to resolve the conflict:`,
    "explain-status"));
  const list = makeEl("div", "", "explain-list");
  for (const id of ids) {
    const c = scenario.constraints.find((x) => x.id === id);
    if (!c) continue;
    const row = makeEl("div", "", "explain-row");
    row.style.setProperty("--cat", constraintTypeColor(c.type));
    const txt = makeEl("div", "", "explain-row-txt");
    txt.append(makeEl("div", c.label || constraintTypeLabel(c.type), "explain-row-name"));
    txt.append(makeEl("div", constraintTypeLabel(c.type) + " · " + constraintSummary(c), "explain-row-meta"));
    if (c.source) txt.append(makeEl("div", "“" + c.source + "”", "explain-row-src"));
    row.append(txt);
    const off = makeEl("button", "Disable", "btn btn-sm");
    off.type = "button";
    off.title = "Turn this rule off and re-solve";
    off.onclick = () => {
      // Re-resolve by id at click time — the captured `c` may be orphaned if the plan changed
      // (undo, example load, tab switch) since the explanation was rendered.
      const live = scenario.constraints.find((x) => x.id === id);
      if (live) live.enabled = false;
      panel.hidden = true;
      render();
    };
    row.append(off);
    list.append(row);
  }
  panel.append(list);
}

// Ask /relax which LOWEST-priority rules to drop to make the plan fit, then APPLY them: disable those
// rules, mark them RELAXED (red in the constraints table), and re-solve. On-demand, like /explain.
async function autoRelax(btn) {
  const panel = $("explain");
  if (panel) {
    panel.hidden = false;
    panel.innerHTML = "";
    panel.append(makeEl("p", "Finding the lowest-priority rules to relax…", "explain-status"));
  }
  if (btn) btn.disabled = true;
  const seq = resultSeq;
  let result;
  try {
    result = await post("/relax", solvePayload());
  } catch (err) {
    if (seq !== resultSeq) return;
    if (panel) { panel.innerHTML = ""; panel.append(makeEl("p", err.message, "explain-status")); }
    return;
  } finally {
    if (btn) btn.disabled = false;
  }
  if (seq !== resultSeq) return; // the plan was re-solved while we waited — discard
  const ruleName = (id) => {
    const c = scenario.constraints.find((x) => x.id === id);
    return c ? (c.label || constraintTypeLabel(c.type)) : id;
  };
  // Structural: no rule can be relaxed to fix it — it's the horizon / activity load.
  if (result.structural) {
    if (panel) { panel.innerHTML = ""; panel.append(makeEl("p",
      "No rule can be relaxed to fix this — even with every rule off, the activities don't fit. "
      + "Try a longer horizon, fewer/shorter activities, or a higher section budget.",
      "explain-status")); }
    return;
  }
  // The remaining conflict is all HARD (P1) rules — relaxation can't help.
  if (!result.solved) {
    const ids = result.hard_conflict || [];
    if (panel) { panel.innerHTML = ""; panel.append(makeEl("p",
      "Can't relax to a solution — the conflict is between hard (P1) rules: "
      + ids.map(ruleName).join(", ") + ". Lower one of their priorities, or turn one off.",
      "explain-status")); }
    return;
  }
  const dropped = result.dropped || [];
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
  if (!dropped.length) { flash("Already fits — nothing to relax"); return; }
  // Apply: disable each dropped rule + mark it relaxed, then re-solve (now feasible).
  for (const id of dropped) {
    const c = scenario.constraints.find((x) => x.id === id);
    if (c) { c.enabled = false; relaxedIds.add(id); }
  }
  const held = scenario.constraints.filter((c) => c.enabled !== false && c.priority <= 2).length;
  render(); // re-solve with the drops applied; the constraints table now shows them red (RELAXED)
  flash(`Relaxed ${dropped.length} rule${dropped.length > 1 ? "s" : ""}` + (held ? " · all P1–P2 held" : ""));
}

// Draw (or redraw) the timeline. Kept separate so a section-collapse toggle can redraw
// instantly from the schedule already on hand, without re-solving.
function drawTimeline(schedule, stale) {
  shownSchedule = schedule;
  shownStale = stale;
  const tl = $("timeline");
  tl.innerHTML = "";
  if (!schedule || !schedule.length) {
    showTimelinePlaceholder("No plan yet — open Browse Library to add activities.");
    return;
  }
  const g = buildGantt(schedule);
  if (stale) g.classList.add("gantt-stale");
  else renderTightness(g, schedule);
  applyZoomTo(g); // size to the current X (time) / Y (row height) zoom
  const scroll = document.createElement("div");
  scroll.className = "gantt-scroll"; // scrolls horizontally when zoomed in past the panel width
  scroll.append(g);
  tl.append(scroll);
  const leg = buildLegend(g);
  if (leg) tl.append(leg);
  tagNarrowBars(tl); // now that the bars are laid out, hide labels on bars too small for text
  renderNowLine(); // the draggable mission-elapsed cursor, positioned over the laid-out tracks
  renderRoster(); // refresh solved times + the selected-row highlight after every redraw
}

// Bars narrower than ~text width drop their name and show just the kind icon (full detail on hover).
// Runs after layout (bars must be in the DOM for offsetWidth) and again on every zoom change.
function tagNarrowBars(scope) {
  const root = scope || $("timeline");
  for (const bar of root.querySelectorAll(".bar.bar-kind")) {
    bar.classList.toggle("bar-narrow", bar.offsetWidth < 48);
  }
}

// ---- the timeline cursor / playhead (video-editor style) -----------------
// A full-height line across the ruler + every lane, parked at `cursorMin`. You move it by clicking or
// dragging ANYWHERE on the chart (like a video editor's playhead), and it magnetically SNAPS to bar
// start/end edges (and day midnights) within a few pixels — hold Alt to bypass. Arrow keys nudge it
// when focused. The gutter offset means we place it in measured pixels (not a % left, like the bars).
const SNAP_PX = 8; // magnetic snap distance to a bar edge, in pixels

// Every time the playhead can snap to: each bar's start & end, plus day midnights in the visible range.
function snapTargets() {
  const t = [];
  for (const it of shownSchedule || []) t.push(it.start, it.end);
  if (axisCtx) {
    for (let d = Math.ceil(axisCtx.t0 / DAY) * DAY; d <= axisCtx.t0 + axisCtx.span; d += DAY) t.push(d);
  }
  return t;
}

// Snap a raw minute value to the nearest target within SNAP_PX (converted to minutes for the current
// zoom), unless bypassed. Returns { min, snapped }.
function snapCursorMin(min, track, bypass) {
  if (bypass || !axisCtx || !track || !track.offsetWidth) return { min, snapped: false };
  const thresh = SNAP_PX * (axisCtx.span / track.offsetWidth);
  let best = min, bestD = thresh, snapped = false;
  for (const edge of snapTargets()) {
    const d = Math.abs(min - edge);
    if (d <= bestD) { bestD = d; best = edge; snapped = true; }
  }
  return { min: best, snapped };
}

// Viewport clientX -> minutes on the axis (all tracks share the x-range, so any lane track works).
function minFromClientX(clientX, track) {
  const r = track.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return axisCtx.t0 + frac * axisCtx.span;
}

function renderNowLine() {
  const g = $("timeline").querySelector(".gantt");
  if (!g || !axisCtx) return;
  g.querySelector(".now-line")?.remove();
  const track = g.querySelector(".gantt-track.lane");
  const rows = g.querySelectorAll(".gantt-lane");
  if (!track || !rows.length) return;
  const { t0, span } = axisCtx;
  if (cursorMin == null) cursorMin = t0; // first show: park at the start
  cursorMin = Math.min(t0 + span, Math.max(t0, cursorMin)); // keep it on the axis

  const line = document.createElement("div");
  line.className = "now-line";
  line.setAttribute("role", "slider");
  line.setAttribute("tabindex", "0");
  line.setAttribute("aria-label", "Timeline cursor — click or drag the timeline to move it, arrow keys to nudge");
  line.append(makeEl("span", timeLabel(cursorMin), "now-label"));
  g.append(line);
  positionNowLine(g); // place it now that it's in the DOM
  line.addEventListener("keydown", (e) => nudgeCursor(e, g));

  // Scrub the playhead by clicking/dragging the ruler or empty track (video-editor style). Wired once
  // per chart. SKIP a bar (clicking a bar selects/edits it — the scrub-drag would otherwise eat the
  // click) and a lane label (its own collapse toggle), so those interactions aren't hijacked.
  if (!g.dataset.scrubWired) {
    g.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".bar") || e.target.closest(".lane-label")) return;
      startScrub(e, g);
    });
    g.dataset.scrubWired = "1";
  }
}

// Place the .now-line at cursorMin using the track column's measured geometry; span it from the ruler
// down through the last lane. `snapped` toggles the "locked to an edge" highlight (color-flip).
function positionNowLine(g, snapped) {
  const line = g.querySelector(".now-line");
  const track = g.querySelector(".gantt-track.lane");
  const rows = g.querySelectorAll(".gantt-lane");
  if (!line || !track || !rows.length || !axisCtx) return;
  const { t0, span } = axisCtx;
  const frac = span > 0 ? (cursorMin - t0) / span : 0;
  const x = track.offsetLeft + frac * track.offsetWidth;
  const axis = g.querySelector(".gantt-axis");
  const top = axis ? axis.offsetTop : rows[0].offsetTop;
  const last = rows[rows.length - 1];
  line.style.left = x + "px";
  line.style.top = top + "px";
  line.style.height = (last.offsetTop + last.offsetHeight - top) + "px";
  if (snapped !== undefined) line.classList.toggle("snapped", !!snapped);
  const lbl = line.querySelector(".now-label");
  if (lbl) lbl.textContent = timeLabel(Math.round(cursorMin));
}

// Seek to the mousedown position, then keep following the mouse until release (a scrub), snapping to
// bar edges as you go (hold Alt to bypass). preventDefault stops text-selection but leaves the click,
// so clicking a bar still selects it AND moves the playhead there.
function startScrub(e, g) {
  const track = g.querySelector(".gantt-track.lane");
  if (!track || !axisCtx) return;
  e.preventDefault();
  const seek = (ev) => {
    const s = snapCursorMin(minFromClientX(ev.clientX, track), track, ev.altKey);
    cursorMin = s.min;
    positionNowLine(g, s.snapped);
  };
  seek(e); // jump to the click immediately
  const up = () => { document.removeEventListener("mousemove", seek); document.removeEventListener("mouseup", up); };
  document.addEventListener("mousemove", seek);
  document.addEventListener("mouseup", up);
}

// Keyboard nudging when the playhead is focused: arrows step (Shift = coarse), Home/End jump to ends.
function nudgeCursor(e, g) {
  if (!axisCtx) return;
  const { t0, span } = axisCtx;
  const step = e.shiftKey ? 60 : 5; // minutes
  const edges = snapTargets();
  if (e.key === "ArrowLeft") cursorMin -= step;
  else if (e.key === "ArrowRight") cursorMin += step;
  else if (e.key === "ArrowUp") { // jump to the previous bar edge (like an NLE's prev-edit)
    const prev = edges.filter((x) => x < cursorMin - 0.5).sort((a, b) => b - a);
    if (prev.length) cursorMin = prev[0];
  } else if (e.key === "ArrowDown") { // next bar edge
    const next = edges.filter((x) => x > cursorMin + 0.5).sort((a, b) => a - b);
    if (next.length) cursorMin = next[0];
  } else if (e.key === "Home") cursorMin = t0;
  else if (e.key === "End") cursorMin = t0 + span;
  else return;
  e.preventDefault();
  cursorMin = Math.min(t0 + span, Math.max(t0, cursorMin));
  positionNowLine(g, false);
}

// ---- one shared timeline tooltip ----------------------------------------
// A single #gantt-tip follows the mouse and shows full detail for whichever bar it's over — one node,
// not one per bar. Delegated off #timeline (which persists across redraws), so it's wired just once.
let ganttTip = null;
function wireGanttTooltip() {
  const tl = $("timeline");
  if (!tl || tl.dataset.tipWired) return;
  tl.dataset.tipWired = "1";
  tl.addEventListener("mousemove", (e) => {
    const bar = e.target.closest(".bar[data-id]");
    if (!bar) { hideGanttTip(); return; }
    showGanttTip(bar, e);
  });
  tl.addEventListener("mouseleave", hideGanttTip);
}
function showGanttTip(bar, e) {
  if (!ganttTip) {
    ganttTip = document.createElement("div");
    ganttTip.id = "gantt-tip";
    ganttTip.hidden = true;
    document.body.append(ganttTip);
  }
  const id = bar.dataset.id;
  const a = findActivity(id);
  const sec = (a && a.section && a.section.trim()) || "—";
  const who = a && a.assignee && a.assignee.trim();
  ganttTip.innerHTML = "";
  ganttTip.append(makeEl("div", displayName(id), "tip-name"));
  ganttTip.append(makeEl("div", timeLabel(+bar.dataset.start) + "–" + timeLabel(+bar.dataset.end), "tip-time"));
  ganttTip.append(makeEl("div", who ? who + " · " + sec : sec, "tip-where"));
  ganttTip.append(makeEl("div", id, "tip-id"));
  ganttTip.hidden = false;
  // Place near the cursor, flipping to the other side near the viewport edges.
  const pad = 14, r = ganttTip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
  ganttTip.style.left = Math.max(4, x) + "px";
  ganttTip.style.top = Math.max(4, y) + "px";
}
function hideGanttTip() { if (ganttTip) ganttTip.hidden = true; }

// Apply the current zoom to a gantt element: X widens it past the panel (so .gantt-scroll scrolls),
// Y scales lane height via a CSS var. Pure presentation — never re-solves.
function applyZoomTo(g) {
  if (!g) return;
  g.style.width = 100 * zoomX + "%";
  g.style.setProperty("--zoom-y", zoomY);
  g.classList.toggle("gantt-zoomed", zoomX > 1.001); // pin the row labels only once it scrolls
}
// Re-apply zoom to the timeline already on screen (called live while dragging the sliders).
// Resizes the chart AND re-steps the axis ticks so the increments adjust to the new zoom.
function applyZoom() {
  const g = $("timeline").querySelector(".gantt");
  applyZoomTo(g);
  renderAxisTicks(g);
  tagNarrowBars($("timeline")); // bar widths changed — re-decide which show their name vs icon only
  if (g) positionNowLine(g); // track geometry changed — keep the cursor aligned
}

// A small legend of the activity KINDS in the drawn plan (swatch + icon -> label), plus a note that
// the lane axis encodes crew (or section). Colors come from the same --kind-* vars the bars use.
function buildLegend(g) {
  const used = [...new Set((shownSchedule || []).map((s) => kindOf(s)))];
  const order = Object.keys(KINDS);
  used.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const leg = document.createElement("div");
  leg.className = "legend";
  for (const k of used) {
    const def = KINDS[k] || {};
    const item = document.createElement("span");
    item.className = "legend-item";
    const sw = makeEl("span", "", "legend-swatch");
    sw.style.background = `var(--kind-${k})`;
    item.append(sw);
    if (def.icon) item.append(makeEl("span", def.icon, "legend-icon"));
    item.append(makeEl("span", def.label || k));
    leg.append(item);
  }
  // Also key the shading bands + tight-deadline outline, but only when they're actually on screen
  // this draw, so the legend explains the greys/washes without listing cues that aren't shown.
  const cue = (bg, label, extraCls) => {
    const item = makeEl("span", "", "legend-item");
    const sw = makeEl("span", "", "legend-swatch" + (extraCls ? " " + extraCls : ""));
    if (bg) sw.style.background = bg;
    item.append(sw);
    item.append(makeEl("span", label));
    leg.append(item);
  };
  if (g) {
    if (g.querySelector(".night-band")) cue("var(--night-band)", "night / sleep");
    if (g.querySelector(".comms-band")) cue("var(--comms-band)", "comms window");
    if (g.querySelector(".closed-band")) cue("var(--closed-fill)", "closed hours");
    if (g.querySelector(".bar-tight, .bar-snug")) cue(null, "tight deadline", "legend-tight");
  }
  if (!leg.children.length) return null;
  leg.append(makeEl("span", "lane = " + groupMode, "legend-note"));
  return leg;
}

// Distinct section names in the current plan (matches buildGantt's grouping).
function sectionNames() {
  return [...new Set(scenario.activities.map((a) => (a.section && a.section.trim()) || "Ungrouped"))];
}

// Overview = every lane collapsed to a summary bar; Lanes = every lane expanded.
function setView(isOverview) {
  overview = isOverview;
  collapsed.clear();
  if (overview) for (const name of currentLaneNames()) collapsed.add(name);
  const btn = $("view-toggle");
  if (btn) btn.textContent = overview ? "Lanes" : "Overview";
  drawTimeline(shownSchedule, shownStale);
}

// Group-by: bucket the lanes by "section" (default), "type", or "assignee". Presentation only —
// redraw, no re-solve. Lane names differ between modes, so re-derive the collapsed set if Overview is on.
function setGroupMode(mode) {
  groupMode = ["section", "type", "assignee"].includes(mode) ? mode : "section";
  const sel = $("group-select");
  if (sel && sel.value !== groupMode) sel.value = groupMode;
  collapsed.clear(); // lane names differ per grouping — re-derive the Overview-collapsed set
  if (overview) for (const name of currentLaneNames()) collapsed.add(name);
  drawTimeline(shownSchedule, shownStale);
}

// The planning window (horizon) in minutes the capacity bar measures against. Uses an explicit
// scenario.horizon if set, else the day-window span, else 24h. A horizon LONGER than one day is
// also a real solver bound (see solvePayload); a sub-day horizon is only this cosmetic budget.
function planHorizon() {
  if (scenario.horizon && scenario.horizon > 0) return scenario.horizon;
  return DAY;
}

// The health strip: status + CAPACITY (used vs. your horizon, over/under/left + a fill bar) +
// finish + tight. Capacity is the 2-second "am I over or under my time budget?" glance.
function renderHealth(status, schedule, stale) {
  const strip = $("health");
  strip.hidden = false;
  strip.innerHTML = "";
  const ok = status === "OPTIMAL" || status === "FEASIBLE";
  const kind = ok ? "ok" : status === "INFEASIBLE" ? "bad" : "warn";
  const label = ok ? "✅ FEASIBLE" : status === "INFEASIBLE" ? "⛔ INFEASIBLE" : "… " + status;
  strip.append(makeEl("span", label, "health-pill health-" + kind));

  // The window the capacity bar measures against. While showing a stale (last-good) plan, use the
  // horizon that plan was actually solved with, so the gauge and the drawn timeline agree.
  const horizon = stale ? solvedHorizon : planHorizon();
  const chip = makeEl("button", "Horizon " + dur(horizon), "health-chip");
  chip.type = "button";
  chip.title = "Click to set your planning window (your time budget, in hours)";
  chip.onclick = () => {
    const v = prompt("Planning window (hours):", String(Math.round((horizon / 60) * 10) / 10));
    if (v === null) return;
    const h = parseFloat(v);
    if (Number.isFinite(h) && h > 0) {
      scenario.horizon = Math.round(h * 60);
      saveTabs();
      scheduleSolve(); // horizon is a real solver bound now — re-solve so the plan + timeline update
    }
  };
  strip.append(chip);

  if (schedule && schedule.length) {
    const caps = activityCaps();
    const hi = Math.max(...schedule.map((s) => s.end));
    // Busy time = booked minutes across every scheduled occurrence. That's the honest
    // "used vs budget" number: the old wall-clock span (last end - first start) read ~100%
    // on any multi-day plan with a recurring activity, and ~0% when unsectioned work ran
    // in parallel (52h of imported work showed as "4h (2%)"). "finishes" still carries
    // the envelope: when the plan actually wraps up.
    const work = schedule.reduce((t, s) => t + (s.end - s.start), 0);
    const pct = horizon > 0 ? Math.round((100 * work) / horizon) : 0;
    const over = work > horizon;

    const bar = document.createElement("div");
    bar.className = "cap-bar" + (over ? " cap-over" : "");
    const fill = document.createElement("div");
    fill.className = "cap-fill";
    fill.style.width = Math.min(100, pct) + "%";
    bar.append(fill);
    strip.append(bar);

    strip.append(makeEl("span", "work " + dur(work) + " / " + dur(horizon) + " (" + pct + "%)", "health-stat"));
    strip.append(
      over
        ? makeEl("span", "OVER by " + dur(work - horizon), "health-stat health-over")
        : makeEl("span", dur(horizon - work) + " left", "health-stat")
    );
    strip.append(makeEl("span", "finishes " + timeLabel(hi), "health-stat"));
    const tight = schedule.filter((s) => isTight(s, caps)).length;
    strip.append(makeEl("span", tight + " tight", "health-stat"));
    if (stale) strip.append(makeEl("span", "(showing last good plan)", "health-note"));

    // After a "Fill window" run: a bordered FILL PREVIEW capsule, so the pack
    // result reads as a temporary mode beside the live stats (accent-blue, not
    // the green of the status pill). Per-section utilization + what didn't fit,
    // with an explicit × back to the live solve.
    if (lastFill && !stale) {
      const group = makeEl("span", "", "health-fill-group");
      group.title = "Result of ⤒ Fill window — replaced by the next live solve";
      group.append(makeEl("span", "FILL PREVIEW", "health-fill-label"));
      for (const [name, s] of Object.entries(lastFill.sections || {})) {
        const label = name === "(no section)" ? "unsectioned" : name;
        group.append(makeEl("span", `${label} ${s.pct}% · ${dur(s.left)} left`, "health-stat"));
      }
      const o = lastFill.overall || {};
      if (o.overflow) group.append(makeEl("span", `⚠ ${dur(o.overflow)} didn't fit`, "health-stat health-over"));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "health-fill-close";
      close.textContent = "×";
      close.title = "Back to the live solve";
      close.setAttribute("aria-label", "Dismiss the fill preview");
      close.onclick = () => { lastFill = null; solveNow(); };
      group.append(close);
      strip.append(group);
    }
  } else {
    strip.append(makeEl("span",
      scenario.activities.length
        ? "no feasible schedule yet — try “Which rules conflict?”"
        : "no activities yet", "health-note"));
  }
}

// The current view's axis range + mode, so renderAxisTicks can rebuild the tick marks on zoom.
let axisCtx = null;

// Draw the timeline. A single-day plan keeps the original axis-fitted view; once the solved
// horizon spans more than a day we switch to a multi-day view (one continuous axis, day markers).
function buildGantt(schedule) {
  return solvedHorizon > DAY ? buildGanttMulti(schedule) : buildGanttDay(schedule);
}

// Shade the CLOSED hours of every enabled working_window behind the lanes, repeated per day across
// [lo, hi). Reads live scenario.constraints (so bands still show over a dimmed last-good schedule on
// INFEASIBLE). A window is section-scoped, so it shades any lane that CONTAINS that section (a crew
// lane mixes sections — `groups` maps lane name -> its items, so we can tell which sections it holds).
function shadeClosedLanes(g, pct, lo, hi, groups) {
  const windows = scenario.constraints.filter(
    (c) => c.enabled !== false && c.type === "working_window"
  );
  if (!windows.length) return;
  const sectionsIn = (items) => new Set((items || []).map((it) => {
    const a = findActivity(it.id);
    return (a && a.section && a.section.trim()) || "Ungrouped";
  }));
  for (const row of g.querySelectorAll(".gantt-lane")) {
    const secs = sectionsIn(groups.get(row.dataset.lane));
    const tracks = row.querySelectorAll(".gantt-track.lane");
    if (!tracks.length) continue;
    for (const w of windows) {
      if (w.section !== "all" && !secs.has(w.section)) continue;
      const o = toMin(w.open), cl = toMin(w.close);
      if (o == null || cl == null || o === cl) continue;
      const gaps = o < cl ? [[0, o], [cl, DAY]] : [[cl, o]];
      for (let day0 = 0; day0 < hi; day0 += DAY) {
        // honor the window's `days` (like the solver does) — a day-gated window (e.g. an HLS/xEVA
        // phase-gate on days [0]) must only shade the days it applies to, not every day.
        const dayIdx = Math.round(day0 / DAY);
        if (Array.isArray(w.days) && !w.days.includes(dayIdx)) continue;
        for (const [g0, g1] of gaps) {
          const s = Math.max(lo, day0 + g0), e = Math.min(hi, day0 + g1);
          if (e <= s) continue;
          for (const track of tracks) {
            const band = document.createElement("div");
            band.className = "closed-band";
            band.style.left = pct(s) + "%";
            band.style.width = (pct(e) - pct(s)) + "%";
            track.prepend(band); // under the bars (prepended like day-gridlines)
          }
        }
      }
    }
  }
}

// Merge overlapping [start,end] intervals into a minimal sorted set.
function mergeIntervals(spans) {
  if (!spans.length) return [];
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  const out = [s[0].slice()];
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1];
    if (s[i][0] <= last[1]) last[1] = Math.max(last[1], s[i][1]);
    else out.push(s[i].slice());
  }
  return out;
}

// Minimum block length (minutes) for an activity to count toward the night band. Real sleep blocks
// are multi-hour; short "pre/post-sleep" wake/wind-down transitions are kind=sleep too, but they
// aren't night — without this floor they'd drag the night shading into morning wake hours.
const NIGHT_MIN_BLOCK = 180;

// Orientation shading behind ALL lanes: --night-band over the hours the crew actually sleeps and
// --comms-band over comms windows. DERIVED from the scheduled items (no hardcoded clock hours) — the
// night band uses only substantial sleep blocks (>= NIGHT_MIN_BLOCK) so wake/wind-down doesn't leak in.
function shadeContextBands(g, pct, lo, hi, schedule) {
  const tracks = g.querySelectorAll(".gantt-track.lane");
  if (!tracks.length) return;
  for (const { cls, kind, minBlock } of [
    { cls: "night-band", kind: "sleep", minBlock: NIGHT_MIN_BLOCK },
    { cls: "comms-band", kind: "comms", minBlock: 0 },
  ]) {
    const merged = mergeIntervals(
      schedule.filter((it) => kindOf(it) === kind && it.end - it.start >= minBlock).map((it) => [it.start, it.end])
    );
    if (!merged.length) continue;
    for (const track of tracks) {
      for (const [s0, e0] of merged) {
        const s = Math.max(lo, s0), e = Math.min(hi, e0);
        if (e <= s) continue;
        const band = document.createElement("div");
        band.className = "ctx-band " + cls;
        band.style.left = pct(s) + "%";
        band.style.width = (pct(e) - pct(s)) + "%";
        track.prepend(band); // under the bars and the working-window closed bands
      }
    }
  }
}

function buildGanttDay(schedule) {
  const g = document.createElement("div");
  g.className = "gantt";

  // Fit the axis to the schedule's own span (padded), so the bars fill the
  // width instead of sitting in a thin slice of a fixed 0–24h axis.
  let t0 = Math.min(...schedule.map((s) => s.start));
  let t1 = Math.max(...schedule.map((s) => s.end));
  const pad = Math.max(15, Math.round((t1 - t0) * 0.05));
  t0 = Math.max(0, t0 - pad);
  t1 = Math.min(DAY, t1 + pad);
  if (!(t1 > t0)) { t0 = 0; t1 = DAY; } // degenerate fallback
  const span = t1 - t0;
  const pct = (min) => (100 * (min - t0)) / span;

  // Time axis: zoom-aware "nice"-stepped ticks. Built empty here; renderAxisTicks fills it and
  // refills it on every zoom change, so the increments get finer zoomed in and coarser zoomed out.
  const axis = document.createElement("div");
  axis.className = "gantt-row gantt-axis";
  axis.append(makeEl("div", "", "gantt-label"));
  const axisTrack = document.createElement("div");
  axisTrack.className = "gantt-track";
  axis.append(axisTrack);
  g.append(axis);

  // Group into swimlanes (crew or section) and render each lane-packed (OPEN by default).
  const groups = laneGroups(schedule);
  for (const [lane, items] of groups) g.append(laneRow(lane, items, pct));
  shadeContextBands(g, pct, t0, t1, schedule);
  shadeClosedLanes(g, pct, t0, t1, groups);
  axisCtx = { t0, span, mode: "day" };
  renderAxisTicks(g);
  return g;
}

// Multi-day timeline: one continuous axis from day 1 to the end of the horizon, with a "Day N"
// marker per day. Bars are positioned as a fraction of the WHOLE horizon (not a fitted span), so a
// day-2 activity sits in the day-2 stripe. Reuses the same section swimlanes as the single-day view.
function buildGanttMulti(schedule) {
  const horizon = solvedHorizon;
  const totalDays = Math.ceil(horizon / DAY);
  const pct = (min) => (100 * min) / horizon;

  const g = document.createElement("div");
  g.className = "gantt gantt-multi";

  // Axis: a "Day N" marker at the start of each day.
  const axis = document.createElement("div");
  axis.className = "gantt-row gantt-axis";
  axis.append(makeEl("div", "", "gantt-label"));
  const axisTrack = document.createElement("div");
  axisTrack.className = "gantt-track";
  // Built empty here; renderAxisTicks fills it with a zoom-aware mix of "Day N" boundaries and
  // clock-time (HH:MM) ticks in between (the per-day gridlines below still mark every day).
  axis.append(axisTrack);
  g.append(axis);

  // Group into swimlanes (crew or section), lane-packed — same grouping as the single-day view.
  const groups = laneGroups(schedule);
  for (const [lane, items] of groups) g.append(laneRow(lane, items, pct));

  // Paint faint day separators behind every packed track so the day stripes line up across all rows.
  // Prepend so they sit under the bars, not over them.
  for (const track of g.querySelectorAll(".gantt-track.lane")) {
    for (let d = 1; d < totalDays; d++) {
      const line = document.createElement("div");
      line.className = "day-gridline";
      line.style.left = pct(d * DAY) + "%";
      track.prepend(line);
    }
  }
  shadeContextBands(g, pct, 0, horizon, schedule);
  shadeClosedLanes(g, pct, 0, horizon, groups);
  axisCtx = { t0: 0, span: horizon, mode: "multi", totalDays };
  renderAxisTicks(g);
  return g;
}

// Group the schedule into swimlanes by the current groupMode, in a stable order: lanes alphabetical,
// with the catch-all buckets ("Shared"/"Untyped"/"Unassigned") last. Returns a Map(laneName -> items).
function laneGroups(schedule) {
  const groups = new Map();
  for (const item of schedule) {
    const lane = laneOf(item, groupMode);
    if (!groups.has(lane)) groups.set(lane, []);
    groups.get(lane).push(item);
  }
  const ordered = new Map();
  for (const name of orderLanes([...groups.keys()])) ordered.set(name, groups.get(name));
  return ordered;
}
function orderLanes(names) {
  // Alphabetical, with the catch-all buckets pushed to the end. No special-casing of any value.
  const tail = (n) => n === "Shared" || n === "Untyped" || n === "Unassigned";
  return [...names].sort((a, b) => tail(a) - tail(b) || a.localeCompare(b));
}

// Greedy first-fit packing: returns sub-lanes (arrays of items) where no two items in a sub-lane
// overlap. Sequential tasks share a row; genuinely-parallel tasks open a new one — never stacked.
function packSubLanes(items) {
  const subs = [];
  for (const it of [...items].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let sub = subs.find((s) => s.lastEnd <= it.start);
    if (!sub) { sub = []; sub.lastEnd = -Infinity; subs.push(sub); }
    sub.push(it);
    sub.lastEnd = it.end;
  }
  return subs;
}

// Lane utilization %: union of busy intervals (so parallel sub-lanes don't double-count) over the
// drawn horizon. The 2-second "how loaded is this crew/section?" read in the lane gutter.
function laneUtil(items) {
  const h = solvedHorizon || DAY;
  if (!h || !items.length) return null;
  let busy = 0, s = null, e = null;
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    if (e === null || it.start > e) { if (e !== null) busy += e - s; s = it.start; e = it.end; }
    else e = Math.max(e, it.end);
  }
  if (e !== null) busy += e - s;
  return Math.round((100 * busy) / h);
}

// Lane names of the drawn plan (for the Overview toggle, which collapses every lane). Empty if no plan.
function currentLaneNames() {
  return shownSchedule && shownSchedule.length ? [...laneGroups(shownSchedule).keys()] : [];
}

// One swimlane row: a gutter (caret + name + count + util% + ⚠) and a STACK of greedy-packed tracks
// (so non-overlapping tasks share a row). Collapsed -> one roll-up summary bar. Click toggles it.
function laneRow(lane, items, pct) {
  const isOpen = !collapsed.has(lane);
  const caps = activityCaps();
  const tight = items.some((it) => isTight(it, caps));
  const row = document.createElement("div");
  row.className = "gantt-row gantt-lane";
  row.dataset.lane = lane;

  const label = document.createElement("div");
  label.className = "gantt-label lane-label";
  const top = makeEl("div", "", "lane-top");
  top.append(makeEl("span", isOpen ? "▾" : "▸", "sec-caret"));
  const name = makeEl("span", laneDisplay(lane), "sec-name");
  if (laneDisplay(lane) !== lane) name.title = lane; // hover shows the raw section id
  top.append(name);
  top.append(makeEl("span", String(items.length), "sec-count"));
  if (tight) top.append(makeEl("span", "⚠", "sec-warn"));
  label.append(top);
  const util = laneUtil(items);
  if (util != null) label.append(makeEl("span", util + "%", "lane-util"));
  label.title = `${lane} — ${items.length} task(s)` + (util != null ? `, ${util}% utilized` : "") +
    (isOpen ? "" : " (click to expand)");
  onActivate(label, () => {
    if (collapsed.has(lane)) collapsed.delete(lane);
    else collapsed.add(lane);
    drawTimeline(shownSchedule, shownStale);
  });
  row.append(label);

  const stack = document.createElement("div");
  stack.className = "lane-stack";
  if (isOpen) {
    for (const sub of packSubLanes(items)) {
      const track = document.createElement("div");
      track.className = "gantt-track lane";
      for (const it of sub) track.append(activityBar(it, pct));
      stack.append(track);
    }
  } else {
    const track = document.createElement("div");
    track.className = "gantt-track lane";
    const lo = Math.min(...items.map((i) => i.start));
    const hi = Math.max(...items.map((i) => i.end));
    const bar = document.createElement("div");
    bar.className = "bar bar-summary" + (tight ? " bar-snug" : "");
    bar.style.left = pct(lo) + "%";
    bar.style.width = Math.max(0.8, pct(hi) - pct(lo)) + "%";
    bar.title = `${lane}: ${timeLabel(lo)}–${timeLabel(hi)}, ${items.length} task(s)`;
    bar.append(makeEl("span", `${items.length} tasks`, "bar-time"));
    track.append(bar);
    stack.append(track);
  }
  row.append(stack);
  return row;
}

// One positioned bar for a scheduled item: kind color + icon + clean name in-bar (time shows on
// hover via the shared tooltip, not in-bar). Reusable — a single packed track holds several of these
// (Phase 2), so this is factored out of the row. Clicking selects + opens the Inspector (no re-solve).
function activityBar(item, pct) {
  const bar = document.createElement("div");
  bar.className = "bar bar-kind" + (sourceId(item.id) === selectedId ? " selected" : "");
  bar.dataset.id = item.id;
  bar.dataset.start = item.start;
  bar.dataset.end = item.end;
  bar.style.left = pct(item.start) + "%";
  bar.style.width = Math.max(0.8, pct(item.end) - pct(item.start)) + "%";
  bar.style.background = barColor(item);
  bar.setAttribute("aria-label", `${displayName(item.id)} ${timeLabel(item.start)}–${timeLabel(item.end)}`);
  bar.append(makeEl("span", iconFor(item), "bar-icon"));
  bar.append(makeEl("span", displayName(item.id), "bar-name"));
  onActivate(bar, () => {
    selectedId = sourceId(item.id);
    drawTimeline(shownSchedule, shownStale);
    renderInspector();
    openInspector();
  });
  return bar;
}

// Pick a round tick spacing (in minutes) so the single-day axis shows ~6 labels per panel-width.
// Zooming in (zoom > 1) widens the chart, so we aim for more labels -> finer increments.
function niceStep(span, zoom = 1) {
  const target = span / (6 * zoom);
  // Round step sizes we allow, smallest first; use the first one big enough.
  for (const s of [5, 10, 15, 30, 60, 120, 180, 240, 360, 720]) if (s >= target) return s;
  return 1440;
}

// Like niceStep but for the multi-day axis: steps run from sub-day hours (zoomed in) up to whole
// days / several days (zoomed out or a long horizon), so the markers never crowd.
function niceStepMulti(span, zoom = 1) {
  const target = span / (8 * zoom);
  for (const s of [60, 120, 180, 240, 360, 720, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY])
    if (s >= target) return s;
  return Math.ceil(target / DAY) * DAY; // very long horizon: round up to whole days
}

// (Re)draw the time-axis tick labels for gantt `g`, sized to the current zoom. Called once at build
// time and again on every zoom change (applyZoom), so the increments adapt live. Reads axisCtx,
// which the builders set with the view's mode + range.
function renderAxisTicks(g) {
  if (!g || !axisCtx) return;
  const axisTrack = g.querySelector(".gantt-axis .gantt-track");
  if (!axisTrack) return;
  axisTrack.querySelectorAll(".tick-label").forEach((el) => el.remove());
  const { t0, span, mode, totalDays } = axisCtx;
  const pct = (min) => (100 * (min - t0)) / span;
  if (mode === "multi") {
    // One continuous axis across the whole horizon: a bold "Day N" at each day boundary, with
    // clock-time (HH:MM) ticks in between. Zoom in -> hour-level marks; zoom out -> day boundaries.
    const step = niceStepMulti(span, zoomX);
    for (let t = 0; t <= span + 0.5; t += step) {
      const onDay = t % DAY === 0;
      const dayIdx = Math.round(t / DAY);
      if (onDay && dayIdx >= totalDays) continue; // skip the boundary at the horizon's far edge
      const txt = onDay ? "Day " + (dayIdx + 1) : hhmm(t % DAY);
      const tick = makeEl("span", txt, "tick-label" + (onDay ? " tick-day" : ""));
      tick.style.left = pct(t) + "%";
      axisTrack.append(tick);
    }
  } else {
    const step = niceStep(span, zoomX);
    for (let t = Math.ceil(t0 / step) * step; t <= t0 + span + 0.5; t += step) {
      const tick = makeEl("span", hhmm(t), "tick-label");
      tick.style.left = pct(t) + "%";
      axisTrack.append(tick);
    }
  }
}

function hhmm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
// Like hhmm but prefixes the day for a multi-day plan, e.g. 1500 -> "D2 01:00".
function hhmmDay(min) {
  return "D" + (Math.floor(min / DAY) + 1) + " " + hhmm(((min % DAY) + DAY) % DAY);
}
// The time label to show the user. Single-day plans read plain "HH:MM" (unchanged); once the
// solved horizon spans more than a day, times read "D2 01:00" so day-2+ values aren't shown as 25:00.
function timeLabel(min) {
  return solvedHorizon > DAY ? hhmmDay(min) : hhmm(min);
}
// "HH:MM" -> minutes since midnight (inverse of hhmm); null/blank -> null.
function toMin(hm) {
  if (!hm) return null;
  const [h, m] = String(hm).split(":").map(Number);
  return h * 60 + m;
}
// Compact duration, e.g. 135 -> "2h 15m", 45 -> "45m", 120 -> "2h".
function dur(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return h + "h " + m + "m";
  if (h) return h + "h";
  return m + "m";
}

// How close each activity runs to its cap — shared by the health strip, the section ⚠ flag,
// and the bar tinting. A cap is the tightest enabled time_window latest_end.
const TIGHT_MIN = 15;
function activityCaps() {
  const dl = new Map();
  for (const c of scenario.constraints) {
    if (c.type !== "time_window" || c.enabled === false || !c.latest_end) continue;
    const d = toMin(c.latest_end);
    if (d == null) continue;
    const cap = d + (c.day || 0) * DAY; // day-relative deadline -> shift the cap onto its mission day
    if (!dl.has(c.activity) || cap < dl.get(c.activity)) dl.set(c.activity, cap);
  }
  return { dl };
}
function slackOf(item, caps) {
  const cap = caps.dl.get(item.id);
  return cap != null ? cap - item.end : null;
}
function isTight(item, caps) {
  const s = slackOf(item, caps);
  return s != null && s <= TIGHT_MIN;
}
// Tint each activity bar by how close it runs to its cap (no extra solve). Summary bars have no
// dataset.id, so they're skipped here — their tight flag is set when the section header is built.
function renderTightness(g, schedule) {
  const caps = activityCaps();
  const byId = new Map(schedule.map((s) => [s.id, s]));
  g.querySelectorAll(".bar").forEach((bar) => {
    const s = byId.get(bar.dataset.id);
    if (!s) return;
    const slack = slackOf(s, caps);
    if (slack != null && slack <= TIGHT_MIN) bar.classList.add(slack <= 5 ? "bar-tight" : "bar-snug");
  });
}

// ---- tiny DOM helpers ---------------------------------------------------
function cardShell(cls) {
  const el = document.createElement("div");
  el.className = "card " + cls;
  return el;
}
function deleteBtn(onClick) {
  const b = document.createElement("button");
  b.className = "del";
  b.textContent = "×";
  b.title = "Delete";
  b.setAttribute("aria-label", "delete");
  b.onclick = onClick;
  return b;
}
function textInput(value, onChange, aria, cls) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value;
  if (aria) inp.setAttribute("aria-label", aria);
  if (cls) inp.className = cls;
  inp.oninput = () => {
    onChange(inp.value);
    scheduleSolve();
  };
  return inp;
}
function field(label, value, type, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(makeEl("span", label, "field-lbl"));
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value;
  inp.oninput = () => {
    onChange(inp.value);
    scheduleSolve();
  };
  wrap.append(inp);
  return wrap;
}
function numField(label, value, onChange) {
  return field(label, value, "number", (v) => onChange(parseInt(v, 10)));
}
function textField(label, value, onChange) {
  return field(label, value, "text", onChange);
}
// Distinct assignee values already used in the plan, for the Inspector's autocomplete (so you reuse
// "Alice" instead of retyping it, which keeps lanes from fragmenting on typos).
function assigneeValues() {
  return [...new Set(scenario.activities.map((a) => a.assignee && a.assignee.trim()).filter(Boolean))].sort();
}
// A free-text field with a <datalist> of suggestions. Display-only, so on edit we persist + REDRAW
// the timeline (regroup) without re-solving — assignee never affects the schedule.
function assigneeField(label, value, suggestions, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(makeEl("span", label, "field-lbl"));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value;
  inp.placeholder = "e.g. Alice / Worker 1 / Crew A";
  if (suggestions.length) {
    const dl = document.createElement("datalist");
    dl.id = "assignee-suggestions";
    for (const s of suggestions) { const o = document.createElement("option"); o.value = s; dl.append(o); }
    wrap.append(dl);
    inp.setAttribute("list", dl.id);
  }
  inp.oninput = () => {
    onChange(inp.value);
    saveTabs();                               // persist like other plan edits
    drawTimeline(shownSchedule, shownStale);  // regroup if grouped by assignee — no re-solve needed
  };
  wrap.append(inp);
  return wrap;
}
function activitySelect(label, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(makeEl("span", label, "field-lbl"));
  const sel = document.createElement("select");
  const ids = scenario.activities.map((a) => a.id);
  if (!ids.length) {
    // No activities to pick from (e.g. building a constraint on an empty plan) — show a hint
    // instead of a blank, un-fillable dropdown.
    const opt = document.createElement("option");
    opt.textContent = "— no activities —";
    opt.disabled = true;
    opt.selected = true;
    sel.append(opt);
  }
  if (value && !ids.includes(value)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = `(missing: ${value})`;
    opt.disabled = true;
    opt.selected = true;
    sel.append(opt);
  }
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    if (id === value) opt.selected = true;
    sel.append(opt);
  }
  sel.onchange = () => {
    onChange(sel.value);
    scheduleSolve();
  };
  wrap.append(sel);
  return wrap;
}
// Checkbox list for a no_overlap subset; `selected` is the current id array.
// Includes any selected ids that no longer exist as activities, flagged "(missing: …)".
function activityChecklist(selected, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(makeEl("span", "activities", "field-lbl"));
  const list = document.createElement("div");
  list.className = "checklist";
  const ids = scenario.activities.map((a) => a.id);
  const dangling = selected.filter((id) => !ids.includes(id));
  const toggle = (id, on) => {
    const next = selected.filter((x) => x !== id);
    if (on) next.push(id);
    onChange(next);
    render();
  };
  for (const id of ids) {
    list.append(checkboxRow(id, id, selected.includes(id), (on) => toggle(id, on)));
  }
  for (const id of dangling) {
    list.append(checkboxRow(id, `(missing: ${id})`, true, (on) => toggle(id, on)));
  }
  if (!ids.length && !dangling.length)
    list.append(makeEl("span", "No activities to choose from.", "hint"));
  wrap.append(list);
  return wrap;
}
function checkboxRow(value, label, checked, onChange) {
  const row = document.createElement("label");
  row.className = "check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.onchange = () => onChange(cb.checked);
  row.append(cb);
  row.append(makeEl("span", label));
  return row;
}
// Ordered, editable list of activity slots for a sequence; top-to-bottom is array order.
// `steps` is the current id array; each row picks its activity, with move/remove controls.
function sequenceEditor(steps, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(makeEl("span", "steps (in order)", "field-lbl"));
  const list = document.createElement("div");
  list.className = "sequence";
  const update = (next) => {
    onChange(next);
    render();
  };
  steps.forEach((id, i) => {
    const row = document.createElement("div");
    row.className = "seq-step";
    row.append(makeEl("span", String(i + 1) + ".", "seq-num"));
    row.append(activitySelect("", id, (v) => {
      const next = steps.slice();
      next[i] = v;
      onChange(next);
    }));
    row.append(moveBtn("▲", "Move up", i === 0, () => {
      const next = steps.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      update(next);
    }));
    row.append(moveBtn("▼", "Move down", i === steps.length - 1, () => {
      const next = steps.slice();
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      update(next);
    }));
    row.append(deleteBtn(() => update(steps.filter((_, j) => j !== i))));
    list.append(row);
  });
  if (!steps.length) list.append(makeEl("span", "No steps yet.", "hint"));
  const add = document.createElement("button");
  add.className = "btn btn-ghost btn-sm seq-add";
  add.textContent = "+ Add step";
  add.onclick = () => update([...steps, scenario.activities[0]?.id || ""]);
  list.append(add);
  wrap.append(list);
  return wrap;
}
function moveBtn(glyph, title, disabled, onClick) {
  const b = document.createElement("button");
  b.className = "seq-move";
  b.textContent = glyph;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.disabled = disabled;
  b.onclick = onClick;
  return b;
}
function selectField(label, value, options, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(makeEl("span", label, "field-lbl"));
  const sel = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.onchange = () => {
    onChange(sel.value);
    scheduleSolve();
  };
  wrap.append(sel);
  return wrap;
}
// Make an element with text and an optional CSS class. Used all over the rendering code.
function makeEl(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// Make a non-button element (timeline bar, roster row, section header) behave like a button:
// click + keyboard (Enter/Space) + focusable, so it's reachable without a mouse.
function onActivate(el, fn) {
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.onclick = fn;
  el.onkeydown = (e) => {
    if (e.target !== el) return; // let child controls (e.g. the × delete button) handle their own keys
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(e); }
  };
}
