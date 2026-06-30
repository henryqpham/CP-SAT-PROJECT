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
// The id of the activity the user clicked in the timeline. The Inspector panel edits this one.
let selectedId = null;
// Timeline view: false = Lanes (per-section), true = Overview (lanes collapsed to summary bars).
let overview = false;
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

// ---- wiring -------------------------------------------------------------
addConstraintType("sequence", "Sequence (ordered)");
addConstraintType("working_window", "Working window (open hours)");
addConstraintType("section_budget", "Section budget (max minutes)");

$("parse-btn").onclick = () =>
  withBusy($("parse-btn"), "Parsing…", async () => {
    const sentence = $("sentence").value.trim();
    if (!sentence) return;
    scenario = await post("/parse", { sentence });
    render();
  });

$("solve-btn").onclick = () => solveNow();
$("view-toggle").onclick = () => setView(!overview);

// Undo / redo + plan file actions (save / load / duplicate). State/presentation only — the solver
// still runs on the live plan; these just move snapshots around.
$("undo-btn").onclick = undo;
$("redo-btn").onclick = redo;
$("plan-duplicate").onclick = duplicateTab;
$("plan-export").onclick = exportPlan;
$("plan-import").onclick = () => $("plan-import-file").click();
$("plan-import-file").onchange = (e) => { if (e.target.files[0]) importPlan(e.target.files[0]); e.target.value = ""; };
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
  if (!$("library-modal").hidden) closeLibrary();
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
  return withBusy($("solve-btn"), "Solving…", async () => {
    renderResult(await post("/solve", solvePayload()));
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
function clearResult() {
  lastFeasibleSchedule = null;
  shownSchedule = null;
  shownStale = false;
  solvedHorizon = DAY;
  $("timeline").innerHTML = "";
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
  draftConstraint = null;
  closeAddConstraintModal();
  render();
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
  updateHistoryButtons();
}
function undo() {
  flushHistory();                  // bank the latest in-flight edit first, so it's undoable
  if (!histUndo.length) return;
  histRedo.push(histPresent);
  histPresent = histUndo.pop();
  applyHistory();
}
function redo() {
  if (!histRedo.length) return;
  histUndo.push(histPresent);
  histPresent = histRedo.pop();
  applyHistory();
}
// Swap the live scenario to histPresent and refresh everything (render() re-solves). recordHistory
// fires from that render but no-ops, since scenario now equals histPresent.
function applyHistory() {
  scenario = JSON.parse(histPresent);
  selectedId = null;
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
  const base = { id: uniqueConstraintId(), type, enabled: true, source: "", label: "" };
  if (type === "time_window")
    return { ...base, activity: a0, earliest: null, latest_end: null };
  if (type === "precedence")
    return { ...base, before: a0, after: a1 };
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
      row.append(makeEl("span", a.id, "roster-name"));
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
let librarySort = "name";
let libraryPage = 0; // 0-based page in the card grid
const LIB_PAGE = 48; // cards per page
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
  } catch {
    /* leave LIBRARY/TYPES empty — no hardcoded fallback data */
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
// The catalog = file (library.json) templates + the user's saved ones. Keep the SAME element
// references (no per-item copy) so customTemplates.includes(tpl) works for the remove button.
function allTemplates() {
  return [...LIBRARY, ...customTemplates];
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
function libCardEl(tpl) {
  const card = document.createElement("div");
  card.className = "lib-card";
  card.style.setProperty("--cat", (TYPES[tpl.category] && TYPES[tpl.category].color) || "var(--muted)");

  // "× N in plan": how many activities in the current plan came from this template (matched by id base).
  const base = slug(tpl.label);
  const used = scenario.activities.filter((a) => a.id === base || a.id.startsWith(base + "_")).length;
  if (used > 0) card.append(makeEl("span", "×" + used, "lib-card-used"));

  card.append(makeEl("div", tpl.label, "lib-card-name"));
  const meta = [(TYPES[tpl.category] && TYPES[tpl.category].label) || tpl.category, tpl.section].filter(Boolean);
  if (meta.length) card.append(makeEl("div", meta.join(" · "), "lib-card-meta"));
  card.append(makeEl("div", dur(tpl.minutes), "lib-card-dur"));

  const foot = makeEl("div", "", "lib-card-foot");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn btn-sm lib-card-add";
  add.textContent = "+ Add";
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
  };
  foot.append(add);
  // User-saved templates get a "saved" tag + a × to remove; seed (library.json) cards don't.
  if (customTemplates.includes(tpl)) {
    foot.append(makeEl("span", "saved", "lib-row-saved"));
    const rm = deleteBtn(() => {
      const i = customTemplates.indexOf(tpl);
      if (i > -1) customTemplates.splice(i, 1);
      saveTemplates();
      renderLibraryList();
    });
    rm.title = "Remove saved template";
    foot.append(rm);
  }
  card.append(foot);
  return card;
}

// Refresh the whole modal: rail facets + active pills + sort state, then draw the current PAGE of
// filtered/sorted templates as a card grid, plus the "Showing N of M" count and the numbered pager.
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

  // Clamp the page in case a filter shrank the result set, then slice out this page.
  const pageCount = Math.ceil(rows.length / LIB_PAGE);
  if (libraryPage >= pageCount) libraryPage = pageCount - 1;
  if (libraryPage < 0) libraryPage = 0;
  const pageRows = rows.slice(libraryPage * LIB_PAGE, libraryPage * LIB_PAGE + LIB_PAGE);

  if (count) count.textContent = `Showing ${pageRows.length} of ${rows.length}`;
  const frag = document.createDocumentFragment();
  for (const tpl of pageRows) frag.append(libCardEl(tpl));
  box.append(frag);
  renderLibraryPager(pageCount);
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
    if (next) {
      act.id = next;
      selectedId = next;
    }
  }, "activity id"));
  box.append(idField);

  // duration (minutes) + section (blank = Ungrouped) — both mutate + re-solve.
  box.append(numField("duration (min)", act.duration, (v) => {
    if (!Number.isNaN(v)) act.duration = v;
  }));
  box.append(textField("section", act.section || "", (v) => (act.section = v.trim() || null)));

  // type: placeholder select (only "None" for now; later phases add real types).
  const typeOpts = [{ value: "", label: "None" }].concat(
    Object.entries(TYPES).map(([v, t]) => ({ value: v, label: t.label }))
  );
  box.append(selectField("type", act.type || "", typeOpts, (v) => (act.type = v || null)));

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
let constraintsPage = 0; // 0-based page in the constraint card grid

// How many cards fit the visible grid right now, so a page FILLS the area before paginating.
// Measures the grid box (it's flex:1, so its size = the available area). Falls back when the modal
// isn't visible yet (hidden -> 0 height). Card cell ~ 200px wide (minmax 190 + gap), ~112px tall.
function conPageSize() {
  const box = $("constraints");
  const w = box ? box.clientWidth : 0;
  const h = box ? box.clientHeight : 0;
  if (!w || !h) return 60; // not measurable (modal hidden) — generous fallback
  const cols = Math.max(1, Math.floor((w + 10) / 200));
  const rows = Math.max(1, Math.floor((h + 10) / 112));
  return cols * rows;
}

const CON_TYPE_LABEL = {
  time_window: "Time window", no_overlap: "No overlap", precedence: "Precedence",
  sequence: "Sequence", conditional: "Conditional", working_window: "Working window",
  section_budget: "Section budget",
};
function constraintTypeLabel(t) { return CON_TYPE_LABEL[t] || t; }
// Type -> tint color (a CSS var string), used as the card's --cat border/wash. Mirrors the old
// con-dot colors so each type reads the same as in the rest of the UI.
const CON_TYPE_COLOR = {
  time_window: "var(--accent)", working_window: "var(--accent)", precedence: "var(--ok)",
  sequence: "var(--warn)", conditional: "var(--violet)", no_overlap: "var(--muted)",
  section_budget: "var(--warn)",
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
    return (c.activity || "—") + (w ? " · " + w : "");
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

// Build one constraint CARD, reusing the library card styling (tinted by the type color via --cat):
// title (label), a type·summary meta line, and a footer with enable, Edit, and delete. Editing
// happens in the add-constraint popup (EDIT mode) — the card itself isn't inline-editable anymore.
function conCardEl(c) {
  const card = document.createElement("div");
  card.className = "lib-card con-card" + (c.enabled === false ? " off" : "");
  card.style.setProperty("--cat", constraintTypeColor(c.type));

  card.append(makeEl("div", c.label || constraintTypeLabel(c.type), "lib-card-name"));
  card.append(makeEl("div", constraintTypeLabel(c.type) + " · " + constraintSummary(c), "lib-card-meta"));

  const foot = makeEl("div", "", "lib-card-foot");
  // Enable toggle: flips c.enabled + re-solves, but must NOT open the editor.
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = c.enabled !== false;
  cb.title = "Enabled";
  cb.setAttribute("aria-label", "enabled");
  cb.onchange = () => { c.enabled = cb.checked; card.classList.toggle("off", !cb.checked); scheduleSolve(); };
  foot.append(cb);

  const edit = makeEl("button", "Edit", "btn btn-sm con-card-edit");
  edit.type = "button";
  edit.onclick = (e) => { e.stopPropagation(); openEditConstraintModal(c); };
  foot.append(edit);

  const del = deleteBtn((e) => {
    e.stopPropagation();
    const i = scenario.constraints.indexOf(c);
    if (i >= 0) scenario.constraints.splice(i, 1);
    render();
  });
  foot.append(del);

  card.append(foot);
  return card;
}

// The constraints list as a paginated CARD GRID (same look as the Library): filtered by search +
// type chips, one card per rule, edited in the add-constraint popup. Scales to hundreds.
function renderConstraints() {
  const box = $("constraints");
  if (!box) return;
  box.innerHTML = "";
  const cons = scenario.constraints;

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
  if (pager) pager.innerHTML = "";

  if (!cons.length) box.append(makeEl("p", "No constraints yet — use “+ Constraint” to add one.", "hint"));
  else if (!rows.length) box.append(makeEl("p", "No constraints match this filter.", "hint"));
  else {
    // Fit as many cards as the grid area holds, then paginate. Clamp the page if a filter shrank
    // the result set.
    const pageSize = conPageSize();
    const pageCount = Math.ceil(rows.length / pageSize);
    if (constraintsPage >= pageCount) constraintsPage = pageCount - 1;
    if (constraintsPage < 0) constraintsPage = 0;
    const pageRows = rows.slice(constraintsPage * pageSize, constraintsPage * pageSize + pageSize);
    const frag = document.createDocumentFragment();
    for (const c of pageRows) frag.append(conCardEl(c));
    box.append(frag);
    renderConstraintsPager(pageCount);
  }

  const btn = $("open-constraints");
  if (btn) btn.textContent = `⚙ Manage constraints (${cons.length})`;
}

// Numbered pager for the constraint cards — mirrors renderLibraryPager, reusing pageWindow() + the
// .lib-pager / .lib-page styling. Renders nothing when there's only one page.
function renderConstraintsPager(pageCount) {
  const box = $("constraints-pager");
  if (!box || pageCount <= 1) return;
  const pageBtn = (label, page, opts = {}) => {
    const b = makeEl("button", label, "lib-page" + (opts.active ? " active" : ""));
    b.type = "button";
    if (opts.disabled) b.disabled = true;
    else b.onclick = () => { constraintsPage = page; renderConstraints(); };
    return b;
  };
  box.append(pageBtn("‹ Prev", constraintsPage - 1, { disabled: constraintsPage <= 0 }));
  for (const p of pageWindow(constraintsPage, pageCount)) {
    if (p === "…") box.append(makeEl("span", "…", "lib-page-gap"));
    else box.append(pageBtn(String(p + 1), p, { active: p === constraintsPage }));
  }
  box.append(pageBtn("Next ›", constraintsPage + 1, { disabled: constraintsPage >= pageCount - 1 }));
}

function constraintFields(c) {
  const f = [];
  if (c.type === "time_window") {
    f.push(activitySelect("activity", c.activity, (v) => (c.activity = v)));
    f.push(textField("earliest (HH:MM)", c.earliest || "", (v) => (c.earliest = v || null)));
    f.push(textField("latest end (HH:MM)", c.latest_end || "", (v) => (c.latest_end = v || null)));
  } else if (c.type === "precedence") {
    f.push(activitySelect("before", c.before, (v) => (c.before = v)));
    f.push(activitySelect("after", c.after, (v) => (c.after = v)));
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
  // Every new result clears any open "why infeasible" explanation from the previous solve.
  const explain = $("explain");
  if (explain) { explain.hidden = true; explain.innerHTML = ""; }

  if (status === "OPTIMAL" || status === "FEASIBLE") {
    solvedHorizon = result.horizon || DAY; // size the timeline to what the solver used
    if (result.schedule && result.schedule.length) {
      lastFeasibleSchedule = result.schedule;
      renderHealth(status, result.schedule, false);
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
    if (lastFeasibleSchedule) {
      renderHealth(status, lastFeasibleSchedule, true);
      drawTimeline(lastFeasibleSchedule, true);
    } else {
      renderHealth(status, null, false);
      $("timeline").innerHTML = "";
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
  let result;
  try {
    result = await post("/explain", solvePayload());
  } catch (err) {
    panel.innerHTML = "";
    panel.append(makeEl("p", err.message, "explain-status"));
    return;
  } finally {
    if (btn) btn.disabled = false;
  }
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
    off.onclick = () => { c.enabled = false; panel.hidden = true; render(); };
    row.append(off);
    list.append(row);
  }
  panel.append(list);
}

// Draw (or redraw) the timeline. Kept separate so a section-collapse toggle can redraw
// instantly from the schedule already on hand, without re-solving.
function drawTimeline(schedule, stale) {
  shownSchedule = schedule;
  shownStale = stale;
  const tl = $("timeline");
  tl.innerHTML = "";
  if (!schedule || !schedule.length) return;
  const g = buildGantt(schedule);
  if (stale) g.classList.add("gantt-stale");
  else renderTightness(g, schedule);
  applyZoomTo(g); // size to the current X (time) / Y (row height) zoom
  const scroll = document.createElement("div");
  scroll.className = "gantt-scroll"; // scrolls horizontally when zoomed in past the panel width
  scroll.append(g);
  tl.append(scroll);
  const leg = buildLegend();
  if (leg) tl.append(leg);
  renderRoster(); // refresh solved times + the selected-row highlight after every redraw
}

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
}

// A small legend of the activity types currently in use (color swatch -> label).
function buildLegend() {
  const used = [...new Set(scenario.activities.map((a) => a.type).filter((t) => t && TYPES[t]))];
  if (!used.length) return null;
  const leg = document.createElement("div");
  leg.className = "legend";
  for (const t of used) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = TYPES[t].color;
    item.append(sw, makeEl("span", TYPES[t].label));
    leg.append(item);
  }
  return leg;
}

// Distinct section names in the current plan (matches buildGantt's grouping).
function sectionNames() {
  return [...new Set(scenario.activities.map((a) => (a.section && a.section.trim()) || "Ungrouped"))];
}

// Overview = every section collapsed to a summary bar; Lanes = every section expanded.
function setView(isOverview) {
  overview = isOverview;
  collapsed.clear();
  if (overview) for (const s of sectionNames()) collapsed.add(s);
  const btn = $("view-toggle");
  if (btn) btn.textContent = overview ? "Lanes" : "Overview";
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
    const lo = Math.min(...schedule.map((s) => s.start));
    const hi = Math.max(...schedule.map((s) => s.end));
    const span = Math.max(0, hi - lo); // wall-clock the plan occupies (correct with parallel lanes)
    const pct = horizon > 0 ? Math.round((100 * span) / horizon) : 0;
    const over = span > horizon;

    const bar = document.createElement("div");
    bar.className = "cap-bar" + (over ? " cap-over" : "");
    const fill = document.createElement("div");
    fill.className = "cap-fill";
    fill.style.width = Math.min(100, pct) + "%";
    bar.append(fill);
    strip.append(bar);

    strip.append(makeEl("span", dur(span) + " / " + dur(horizon) + " (" + pct + "%)", "health-stat"));
    strip.append(
      over
        ? makeEl("span", "OVER by " + dur(span - horizon), "health-stat health-over")
        : makeEl("span", dur(horizon - span) + " left", "health-stat")
    );
    strip.append(makeEl("span", "finishes " + timeLabel(hi), "health-stat"));
    const tight = schedule.filter((s) => isTight(s, caps)).length;
    strip.append(makeEl("span", tight + " tight", "health-stat"));
    if (stale) strip.append(makeEl("span", "(showing last good plan)", "health-note"));
  } else {
    strip.append(makeEl("span", "no activities yet", "health-note"));
  }
}

// The current view's axis range + mode, so renderAxisTicks can rebuild the tick marks on zoom.
let axisCtx = null;

// Draw the timeline. A single-day plan keeps the original axis-fitted view; once the solved
// horizon spans more than a day we switch to a multi-day view (one continuous axis, day markers).
function buildGantt(schedule) {
  return solvedHorizon > DAY ? buildGanttMulti(schedule) : buildGanttDay(schedule);
}

// Shade the CLOSED hours of every enabled working_window behind the activity lanes, repeated per
// day across [lo, hi). Reads live scenario.constraints (so bands still show over a dimmed
// last-good schedule on INFEASIBLE). A band's lane is matched by the activity id in its label.
function shadeClosedLanes(g, pct, lo, hi) {
  const windows = scenario.constraints.filter(
    (c) => c.enabled !== false && c.type === "working_window"
  );
  if (!windows.length) return;
  const sectionOf = (id) => {
    const a = findActivity(id);
    return (a && a.section && a.section.trim()) || "Ungrouped";
  };
  for (const row of g.querySelectorAll(".gantt-activity")) {
    const id = row.querySelector(".gantt-label")?.title;
    const track = row.querySelector(".gantt-track.lane");
    if (!id || !track) continue;
    const sec = sectionOf(id);
    for (const w of windows) {
      if (w.section !== "all" && w.section !== sec) continue;
      const o = toMin(w.open), cl = toMin(w.close);
      if (o == null || cl == null || o === cl) continue;
      const gaps = o < cl ? [[0, o], [cl, DAY]] : [[cl, o]];
      for (let day0 = 0; day0 < hi; day0 += DAY) {
        for (const [g0, g1] of gaps) {
          const s = Math.max(lo, day0 + g0), e = Math.min(hi, day0 + g1);
          if (e <= s) continue;
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

  // Group activities into section swimlanes (OPEN by default; click a header to collapse).
  const sectionOf = (id) => {
    const a = findActivity(id);
    return (a && a.section && a.section.trim()) || "Ungrouped";
  };
  const groups = new Map();
  for (const item of schedule) {
    const sec = sectionOf(item.id);
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(item);
  }
  const caps = activityCaps();
  for (const [sec, items] of groups) {
    const isOpen = !collapsed.has(sec);
    const tight = items.some((it) => isTight(it, caps));
    g.append(sectionHeaderRow(sec, items, isOpen, tight, pct));
    if (isOpen) {
      [...items].sort((a, b) => a.start - b.start).forEach((item) => g.append(activityRow(item, pct)));
    }
  }
  shadeClosedLanes(g, pct, t0, t1);
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

  // Group into section swimlanes (same as the single-day view).
  const sectionOf = (id) => {
    const a = findActivity(id);
    return (a && a.section && a.section.trim()) || "Ungrouped";
  };
  const groups = new Map();
  for (const item of schedule) {
    const sec = sectionOf(item.id);
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(item);
  }
  const caps = activityCaps();
  for (const [sec, items] of groups) {
    const isOpen = !collapsed.has(sec);
    const tight = items.some((it) => isTight(it, caps));
    g.append(sectionHeaderRow(sec, items, isOpen, tight, pct));
    if (isOpen) {
      [...items].sort((a, b) => a.start - b.start).forEach((item) => g.append(activityRow(item, pct)));
    }
  }

  // Paint faint day separators behind every lane so the day stripes line up across all rows.
  // Prepend so they sit under the bars, not over them.
  for (const track of g.querySelectorAll(".gantt-track.lane")) {
    for (let d = 1; d < totalDays; d++) {
      const line = document.createElement("div");
      line.className = "day-gridline";
      line.style.left = pct(d * DAY) + "%";
      track.prepend(line);
    }
  }
  shadeClosedLanes(g, pct, 0, horizon);
  axisCtx = { t0: 0, span: horizon, mode: "multi", totalDays };
  renderAxisTicks(g);
  return g;
}

// A section header: caret + name + task count (+ ⚠ if any task is tight), with a rolled-up
// summary bar spanning the section's busy window when collapsed. Clicking it toggles open/closed.
function sectionHeaderRow(sec, items, isOpen, tight, pct) {
  const row = document.createElement("div");
  row.className = "gantt-row gantt-section";

  const label = document.createElement("div");
  label.className = "gantt-label sec-label";
  label.append(makeEl("span", isOpen ? "▾" : "▸", "sec-caret"));
  label.append(makeEl("span", sec, "sec-name"));
  label.append(makeEl("span", String(items.length), "sec-count"));
  if (tight) label.append(makeEl("span", "⚠", "sec-warn"));
  label.title = `${sec} — ${items.length} task(s)` + (isOpen ? "" : " (click to expand)");
  onActivate(label, () => {
    if (collapsed.has(sec)) collapsed.delete(sec);
    else collapsed.add(sec);
    drawTimeline(shownSchedule, shownStale);
  });
  row.append(label);

  const track = document.createElement("div");
  track.className = "gantt-track lane";
  if (!isOpen) {
    const lo = Math.min(...items.map((i) => i.start));
    const hi = Math.max(...items.map((i) => i.end));
    const bar = document.createElement("div");
    bar.className = "bar bar-summary" + (tight ? " bar-snug" : "");
    bar.style.left = pct(lo) + "%";
    bar.style.width = Math.max(0.8, pct(hi) - pct(lo)) + "%";
    bar.title = `${sec}: ${timeLabel(lo)}–${timeLabel(hi)}, ${items.length} task(s)`;
    bar.append(makeEl("span", `${items.length} tasks`, "bar-time"));
    track.append(bar);
  }
  row.append(track);
  return row;
}

// One activity lane (shown when its section is expanded).
function activityRow(item, pct) {
  const row = document.createElement("div");
  row.className = "gantt-row gantt-activity";
  const label = makeEl("div", item.id, "gantt-label");
  label.title = item.id;
  row.append(label);
  const track = document.createElement("div");
  track.className = "gantt-track lane";
  const bar = document.createElement("div");
  bar.className = "bar" + (sourceId(item.id) === selectedId ? " selected" : "");
  bar.dataset.id = item.id;
  bar.style.left = pct(item.start) + "%";
  bar.style.width = Math.max(0.8, pct(item.end) - pct(item.start)) + "%";
  bar.style.background = colorFor(item.id);
  bar.title = `${item.id}: ${timeLabel(item.start)}–${timeLabel(item.end)}`;
  bar.append(makeEl("span", `${timeLabel(item.start)}–${timeLabel(item.end)}`, "bar-time"));
  // Select this activity: re-highlight + open the Inspector from the schedule on hand.
  // Nothing in the scenario changed, so we redraw + refresh — never re-solve.
  onActivate(bar, () => {
    selectedId = sourceId(item.id);
    drawTimeline(shownSchedule, shownStale);
    renderInspector();
    openInspector();
  });
  track.append(bar);
  row.append(track);
  return row;
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
    if (!dl.has(c.activity) || d < dl.get(c.activity)) dl.set(c.activity, d);
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
