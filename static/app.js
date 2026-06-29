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
// Saved plans ("missions"): each tab is { name, scenario }. The active tab's scenario is the live one.
let tabs = [];
let activeTab = 0;
const TABS_KEY = "planner.tabs.v1";
const clone = (x) => JSON.parse(JSON.stringify(x));

const $ = (id) => document.getElementById(id);
const DAY = 24 * 60;
// Activity types -> bar color + legend label, loaded from /static/library.json at startup.
// An activity with no type (or a type the library doesn't define) falls back to the neutral
// bar color from the stylesheet — there is no color data hardcoded here.
let TYPES = {};
// User-defined category styling (color + icon), persisted in localStorage and merged onto TYPES.
let customTypes = {};
const TYPES_KEY = "planner.types.v1";
const colorFor = (id) => {
  const a = scenario.activities.find((x) => x.id === id);
  if (a && a.type && TYPES[a.type]) return TYPES[a.type].color;
  return "var(--bar)";
};

// ---- wiring -------------------------------------------------------------
addConstraintType("sequence", "Sequence (ordered)");

$("parse-btn").onclick = () =>
  withBusy($("parse-btn"), "Parsing…", async () => {
    const sentence = $("sentence").value.trim();
    if (!sentence) return;
    scenario = await post("/parse", { sentence });
    render();
  });

$("solve-btn").onclick = () => solveNow();
$("view-toggle").onclick = () => setView(!overview);

// Example dropdown: fill it from /examples, and load the chosen example into the active plan.
loadExamples();
$("example-select").onchange = async (e) => {
  const name = e.target.value;
  if (!name) return;
  clearAlert();
  try {
    scenario = await getJSON(`/example/${name}`);
    selectedId = null;
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
let libSearchTimer = null;
$("library-search").oninput = (e) => {
  librarySearch = e.target.value;
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(renderLibraryList, 120); // debounce so 600 rows don't rebuild per keystroke
};
$("library-filter").onchange = (e) => { libraryCategory = e.target.value; renderLibraryList(); };
$("library-sort").onchange = (e) => { librarySort = e.target.value; renderLibraryList(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("library-modal").hidden) closeLibrary();
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

// The scenario the SOLVER sees — strips front-end-only fields (e.g. `horizon`, a soft planning
// budget used only by the capacity bar) so they're never sent to /solve.
function solvePayload() {
  const { horizon, ...rest } = scenario;
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
  clearTimeout(solveTimer);
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
  $("timeline").innerHTML = "";
  $("health").hidden = true;
  $("banner").hidden = true;
  const pill = $("status");
  pill.textContent = "";
  pill.className = "pill";
}

$("add-constraint").onclick = () => {
  scenario.constraints.push(newConstraint($("add-constraint-type").value));
  render();
};

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
  if (loadTabs()) {
    scenario = clone(tabs[activeTab].scenario);
  } else {
    scenario = { activities: [], constraints: [] };
    tabs = [{ name: "Plan 1", scenario: clone(scenario) }];
    activeTab = 0;
    saveTabs();
  }
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
  renderTabs();
  render();
}
function newTab() {
  saveTabs();
  tabs.push({ name: `Plan ${tabs.length + 1}`, scenario: { activities: [], constraints: [] } });
  activeTab = tabs.length - 1;
  scenario = clone(tabs[activeTab].scenario);
  selectedId = null;
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
  return base;
}

// ---- rendering ----------------------------------------------------------
function render() {
  renderRoster();
  renderConstraints();
  renderInspector();
  scheduleSolve();
}

// ---- roster ("On this plan") -------------------------------------------
// A clickable list of every activity in the plan: swatch + name + section + solved time, with a
// × to remove it. Clicking a row selects that activity (highlights its bar + opens the Inspector)
// without re-solving — same as clicking the bar on the timeline. Refreshed from render() and at
// the end of drawTimeline() so solved times + the selected highlight stay current.
function renderRoster() {
  const box = $("roster");
  if (!box) return;
  box.innerHTML = "";
  if (!scenario.activities.length) {
    box.append(makeEl("p", "No activities yet — add some from Browse Library.", "hint"));
    return;
  }
  for (const a of scenario.activities) {
    const row = document.createElement("div");
    row.className = "roster-row" + (a.id === selectedId ? " selected" : "");
    const sw = makeEl("span", "", "roster-swatch");
    sw.style.background = colorFor(a.id);
    row.append(sw);
    row.append(makeEl("span", a.id, "roster-name"));
    row.append(makeEl("span", a.section || "Ungrouped", "roster-section"));
    const s = shownSchedule && shownSchedule.find((x) => x.id === a.id);
    row.append(makeEl("span", s ? `${hhmm(s.start)}–${hhmm(s.end)}` : "—", "roster-time"));
    // Same as the timeline bar: re-highlight + open the Inspector, never re-solve.
    row.onclick = () => {
      selectedId = a.id;
      drawTimeline(shownSchedule, shownStale);
      renderInspector();
    };
    const x = deleteBtn((e) => {
      e.stopPropagation(); // don't also select the row
      const i = scenario.activities.findIndex((y) => y.id === a.id);
      if (i >= 0) scenario.activities.splice(i, 1);
      if (selectedId === a.id) selectedId = null;
      render();
    });
    x.classList.add("roster-del");
    row.append(x);
    box.append(row);
  }
}

// ---- library (Browse modal) --------------------------------------------
// A wide, searchable catalog of activity templates loaded from /static/library.json. "+ Add"
// appends a new activity; CP-SAT then places it and the Inspector edits the selected one.
let LIBRARY = [];
// Browse-modal controls (don't re-solve; only "+ Add" changes the plan).
let librarySearch = "";
let libraryCategory = ""; // "" = all categories
let librarySort = "name";
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

// Rebuild the category <select> from the DATA (distinct template categories + TYPES keys),
// preserving the current selection; drop the selection if its category no longer exists.
function rebuildLibraryFilter() {
  const sel = $("library-filter");
  const cats = new Set();
  for (const tpl of allTemplates()) if (tpl.category) cats.add(tpl.category);
  for (const k of Object.keys(TYPES)) cats.add(k);
  const sorted = [...cats].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All categories";
  sel.append(all);
  for (const c of sorted) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = (TYPES[c] && TYPES[c].label) || c;
    sel.append(opt);
  }
  if (libraryCategory && sorted.includes(libraryCategory)) sel.value = libraryCategory;
  else { libraryCategory = ""; sel.value = ""; }
  // mirror the categories into the "+ New" datalist for autocomplete
  const dl = $("lib-cat-options");
  if (dl) {
    dl.innerHTML = "";
    for (const c of sorted) {
      const o = document.createElement("option");
      o.value = c;
      dl.append(o);
    }
  }
  // section suggestions: distinct sections from templates + the current plan
  const secDl = $("lib-sec-options");
  if (secDl) {
    const secs = new Set();
    for (const tpl of allTemplates()) if (tpl.section) secs.add(tpl.section);
    for (const a of scenario.activities) if (a.section) secs.add(a.section);
    secDl.innerHTML = "";
    for (const s of [...secs].sort((a, b) => a.localeCompare(b))) {
      const o = document.createElement("option");
      o.value = s;
      secDl.append(o);
    }
  }
}

// Build one aligned grid row for a template (swatch · name · category · section · dur · actions).
function libRowEl(tpl) {
  const row = document.createElement("div");
  row.className = "lib-row";
  const sw = makeEl("span", "", "lib-row-swatch");
  sw.style.background = (TYPES[tpl.category] && TYPES[tpl.category].color) || "var(--muted)";
  row.append(sw);
  row.append(makeEl("span", tpl.label, "lib-row-name"));
  row.append(makeEl("span", (TYPES[tpl.category] && TYPES[tpl.category].label) || tpl.category || "", "lib-row-cat"));
  row.append(makeEl("span", tpl.section || "", "lib-row-sec"));
  row.append(makeEl("span", dur(tpl.minutes), "lib-row-dur"));
  const actions = makeEl("span", "", "lib-row-actions");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn btn-sm lib-row-add";
  add.textContent = "+ Add";
  add.onclick = () => {
    scenario.activities.push({
      id: uniqueActivityId(slug(tpl.label)),
      duration: tpl.minutes,
      section: tpl.section || null,
      type: tpl.category,
    });
    render(); // roster + (debounced) timeline update; modal stays open
  };
  actions.append(add);
  // User-saved templates get a "saved" tag + a × to remove; seed (library.json) rows don't.
  if (customTemplates.includes(tpl)) {
    actions.append(makeEl("span", "saved", "lib-row-saved"));
    const rm = deleteBtn(() => {
      const i = customTemplates.indexOf(tpl);
      if (i > -1) customTemplates.splice(i, 1);
      saveTemplates();
      renderLibraryList();
    });
    rm.title = "Remove saved template";
    actions.append(rm);
  }
  row.append(actions);
  return row;
}

// Filter + sort the catalog and draw it as an aligned grid with a sticky column header. Search-first
// + a render cap (LIB_CAP) keep it fast at ~600 templates — real queries narrow it instantly.
const LIB_CAP = 200;
function renderLibraryList() {
  rebuildLibraryFilter();
  const box = $("library-list");
  box.innerHTML = "";
  if (!allTemplates().length) {
    box.append(makeEl("p", "No templates yet — use “+ New” above to create one.", "hint"));
    return;
  }
  const q = librarySearch.trim().toLowerCase();
  let rows = allTemplates().filter((tpl) => {
    if (libraryCategory && (tpl.category || "") !== libraryCategory) return false;
    if (!q) return true;
    return String(tpl.label || "").toLowerCase().includes(q)
        || String(tpl.category || "").toLowerCase().includes(q)
        || String(tpl.section || "").toLowerCase().includes(q);
  });
  rows = rows.slice().sort((a, b) => {
    if (librarySort === "duration") return (a.minutes || 0) - (b.minutes || 0);
    if (librarySort === "category")
      return String(a.category || "").localeCompare(String(b.category || ""))
          || String(a.label || "").localeCompare(String(b.label || ""));
    return String(a.label || "").localeCompare(String(b.label || ""));
  });
  if (!rows.length) {
    box.append(makeEl("p", "No matches.", "hint"));
    return;
  }
  // Sticky column header (re-added each render so it stays pinned atop the scroll box).
  const head = document.createElement("div");
  head.className = "lib-row lib-head";
  for (const t of ["", "Name", "Category", "Section", "Dur", ""]) head.append(makeEl("span", t));
  box.append(head);
  // Cap rendered rows; build into a fragment and append once.
  const shown = rows.slice(0, LIB_CAP);
  const frag = document.createDocumentFragment();
  for (const tpl of shown) frag.append(libRowEl(tpl));
  box.append(frag);
  if (rows.length > shown.length) {
    box.append(makeEl("p", `Showing ${shown.length} of ${rows.length} — refine your search.`, "hint lib-cap-note"));
  }
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
  box.append(makeEl("h2", "Inspector", "insp-title"));

  const act = selectedId && scenario.activities.find((a) => a.id === selectedId);
  if (!act) {
    if (selectedId) selectedId = null; // clear a dangling selection (e.g. deleted activity)
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
  const solved = shownSchedule && shownSchedule.find((s) => s.id === act.id);
  if (solved) box.append(makeEl("div", `Scheduled ${hhmm(solved.start)}–${hhmm(solved.end)}`, "insp-solved"));

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

function renderConstraints() {
  const box = $("constraints");
  box.innerHTML = "";
  scenario.constraints.forEach((c, i) => {
    const el = cardShell("constraint" + (c.enabled === false ? " off" : ""));
    const head = document.createElement("div");
    head.className = "card-head";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = c.enabled !== false;
    cb.setAttribute("aria-label", "enabled");
    cb.onchange = () => {
      c.enabled = cb.checked;
      el.classList.toggle("off", !cb.checked);
      scheduleSolve();
    };
    head.append(cb);
    head.append(badge(c.type));
    head.append(textInput(c.label || "", (v) => (c.label = v), "label", "card-title"));
    head.append(deleteBtn(() => {
      scenario.constraints.splice(i, 1);
      render();
    }));
    el.append(head);

    for (const f of constraintFields(c)) el.append(f);
    if (c.source) el.append(makeEl("small", "“" + c.source + "”"));
    box.append(el);
  });
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

  if (status === "OPTIMAL" || status === "FEASIBLE") {
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
    if (lastFeasibleSchedule) {
      banner.textContent = "That change broke the schedule — nothing fits all the rules now.";
      renderHealth(status, lastFeasibleSchedule, true);
      drawTimeline(lastFeasibleSchedule, true);
    } else {
      banner.textContent = "No schedule satisfies all enabled constraints. Try disabling one, or loosen a time window.";
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
  tl.append(g);
  const leg = buildLegend();
  if (leg) tl.append(leg);
  renderRoster(); // refresh solved times + the selected-row highlight after every redraw
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

// The planning window (horizon) in minutes — your time budget for the capacity bar. Uses an
// explicit scenario.horizon if set, else the day-window span, else 24h. It's a SOFT budget (a
// gauge), not a solver limit yet — the solver still runs single-day.
function planHorizon() {
  if (scenario.horizon && scenario.horizon > 0) return scenario.horizon;
  if (scenario.day) {
    const s = toMin(scenario.day.start);
    const e = toMin(scenario.day.end);
    if (s != null && e != null && e > s) return e - s;
  }
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

  // Horizon chip: click to set your planning window (your time budget).
  const horizon = planHorizon();
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
      renderHealth(status, schedule, stale);
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
    strip.append(makeEl("span", "finishes " + hhmm(hi), "health-stat"));
    const tight = schedule.filter((s) => isTight(s, caps)).length;
    strip.append(makeEl("span", tight + " tight", "health-stat"));
    if (stale) strip.append(makeEl("span", "(showing last good plan)", "health-note"));
  } else {
    strip.append(makeEl("span", "no activities yet", "health-note"));
  }
}

function buildGantt(schedule) {
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

  // Time axis: ~6 "nice"-stepped ticks across the fitted window.
  const axis = document.createElement("div");
  axis.className = "gantt-row gantt-axis";
  axis.append(makeEl("div", "", "gantt-label"));
  const axisTrack = document.createElement("div");
  axisTrack.className = "gantt-track";
  const step = niceStep(span);
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const tick = makeEl("span", hhmm(t), "tick-label");
    tick.style.left = pct(t) + "%";
    axisTrack.append(tick);
  }
  axis.append(axisTrack);
  g.append(axis);

  // Group activities into section swimlanes (OPEN by default; click a header to collapse).
  const sectionOf = (id) => {
    const a = scenario.activities.find((x) => x.id === id);
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
  label.onclick = () => {
    if (collapsed.has(sec)) collapsed.delete(sec);
    else collapsed.add(sec);
    drawTimeline(shownSchedule, shownStale);
  };
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
    bar.title = `${sec}: ${hhmm(lo)}–${hhmm(hi)}, ${items.length} task(s)`;
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
  bar.className = "bar" + (item.id === selectedId ? " selected" : "");
  bar.dataset.id = item.id;
  bar.style.left = pct(item.start) + "%";
  bar.style.width = Math.max(0.8, pct(item.end) - pct(item.start)) + "%";
  bar.style.background = colorFor(item.id);
  bar.title = `${item.id}: ${hhmm(item.start)}–${hhmm(item.end)}`;
  bar.append(makeEl("span", `${hhmm(item.start)}–${hhmm(item.end)}`, "bar-time"));
  // Select this activity: re-highlight + open the Inspector from the schedule on hand.
  // Nothing in the scenario changed, so we redraw + refresh — never re-solve.
  bar.onclick = () => {
    selectedId = item.id;
    drawTimeline(shownSchedule, shownStale);
    renderInspector();
  };
  track.append(bar);
  row.append(track);
  return row;
}

// Pick a round tick spacing (in minutes) so the axis shows about 6 labels across `span`.
function niceStep(span) {
  const target = span / 6;
  // Round step sizes we allow, smallest first; use the first one big enough.
  for (const s of [15, 30, 60, 120, 180, 240, 360, 720]) if (s >= target) return s;
  return 1440;
}

function hhmm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
function badge(type) {
  return makeEl("span", type, "badge badge-" + type);
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
