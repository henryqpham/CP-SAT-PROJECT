// core.js — shared foundation consumed by every render module.
//   state · network · alerts · IR helpers · render() dispatcher · DOM helpers
//
// The frontend is split into classic <script> modules (no build step): this file
// declares the shared globals and helpers; editor/gantt/coverage/upload own one
// render area each; main.js wires events last. All cross-module calls happen at
// runtime, so load order only needs core.js first and main.js last.

// ---- shared state -------------------------------------------------------
// The single source of truth: the editable IR. /parse, /example, /extract replace
// it; the editor mutates it in place; /solve receives it.
let scenario = { activities: [], constraints: [] };

// Last /upload response (its `blocks` feed /extract) and last solve result (for
// re-render on zoom). Shared across modules.
let uploadBlocks = null;
let lastResult = null;

// Result/Gantt view state (owned conceptually by the Gantt area, declared here so
// every module shares one binding — e.g. upload clears collapsedSections on import).
let curHorizon = 24 * 60; // minutes covered by the current result (single day default)
let zoomT = 0;            // 0..1 zoom dial for the multi-day Gantt
const collapsedSections = new Set();

const $ = (id) => document.getElementById(id);
const DAY = 24 * 60;
const COLORS = [
  "#4f46e5", "#0891b2", "#16a34a", "#ea580c", "#db2777",
  "#7c3aed", "#ca8a04", "#0d9488", "#2563eb", "#dc2626",
];
const colorFor = (id) => {
  const i = scenario.activities.findIndex((a) => a.id === id);
  return COLORS[(i < 0 ? 0 : i) % COLORS.length];
};

// Join a schedule item to its activity by id, for label/section/resource.
function activityFor(id) {
  return scenario.activities.find((a) => a.id === id) || null;
}
function rowLabel(item) {
  const a = activityFor(item.id);
  return (a && a.label) || item.id;
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
function uniqueActivityId() {
  let n = scenario.activities.length + 1;
  let id;
  do {
    id = `activity_${n++}`;
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
  const base = { id: uniqueConstraintId(), type, enabled: true, source: "" };
  if (type === "time_window")
    return { ...base, activity: a0, earliest: "08:00", latest_end: null, label: "New time window" };
  if (type === "precedence")
    return { ...base, before: a0, after: a1, label: "New precedence" };
  if (type === "no_overlap")
    return { ...base, activities: "all", label: "One thing at a time" };
  if (type === "sequence")
    return { ...base, activities: a0 ? (a1 !== a0 ? [a0, a1] : [a0]) : [], label: "New sequence" };
  if (type === "conditional")
    return {
      ...base,
      when: { activity: a0, present: false },
      then: { set_duration: { activity: a1, factor: 2 } },
      label: "New conditional",
    };
  return base;
}

// ---- render dispatcher --------------------------------------------------
// Re-render the whole editor board from `scenario`. The per-area render
// functions live in editor.js (resolved at call time).
function render() {
  $("board").hidden = false;
  renderProject();
  renderDay();
  renderActivities();
  renderConstraints();
}

// ---- shared DOM helpers -------------------------------------------------
function el_(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function cardShell(cls) {
  const el = document.createElement("div");
  el.className = "card " + cls;
  return el;
}
function badge(type) {
  return el_("span", type, "badge badge-" + type);
}
function swatch(i) {
  const s = document.createElement("span");
  s.className = "swatch";
  s.style.background = COLORS[i % COLORS.length];
  return s;
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
  inp.oninput = () => onChange(inp.value);
  return inp;
}
function field(label, value, type, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(el_("span", label, "field-lbl"));
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value;
  inp.oninput = () => onChange(inp.value);
  wrap.append(inp);
  return wrap;
}
function numField(label, value, onChange) {
  return field(label, value, "number", (v) => onChange(parseInt(v, 10)));
}
function textField(label, value, onChange) {
  return field(label, value, "text", onChange);
}
function selectField(label, value, options, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(el_("span", label, "field-lbl"));
  const sel = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.onchange = () => onChange(sel.value);
  wrap.append(sel);
  return wrap;
}
// A small "<big number> <label>" stat tile.
function stat(value, label) {
  const wrap = el_("div", "", "stat");
  wrap.append(el_("span", String(value), "stat-num"));
  wrap.append(el_("span", label, "stat-lbl"));
  return wrap;
}

// ---- constraint-card locating (shared by Gantt conflicts + coverage clicks) --
// Find a rendered constraint card by id and flag it (red outline).
function highlightConstraint(id) {
  if (!id) return;
  const card = document.querySelector(`.card[data-cid="${cssEscape(id)}"]`);
  if (card) card.classList.add("conflict-hit");
}
function clearConflictHighlights() {
  document.querySelectorAll(".card.conflict-hit").forEach((c) => c.classList.remove("conflict-hit"));
}
// Scroll a card into view and briefly flash it (coverage panel → card link).
// Resolves an id to either a constraint card (data-cid) or an activity card
// (data-aid), so the coverage panel can jump to whichever an item refers to.
function focusCard(id) {
  if (!id) return false;
  const sel = cssEscape(id);
  const card = document.querySelector(`.card[data-cid="${sel}"], .card[data-aid="${sel}"]`);
  if (!card) return false;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("card-focus");
  void card.offsetWidth; // restart the animation
  card.classList.add("card-focus");
  return true;
}
// Back-compat alias (constraint-only).
const focusConstraintCard = focusCard;
// Minimal CSS.escape fallback (ids here are simple, but stay safe).
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}
