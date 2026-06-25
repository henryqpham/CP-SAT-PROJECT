// Dashboard: sentence -> /parse (or Load example) -> editable cards -> /solve -> timeline.
// Multi-day: import a .docx (/upload + /extract), scroll/zoom a multi-day Gantt grouped by section.
let scenario = { activities: [], constraints: [] };

// Last /upload response (its `blocks` feed /extract) and last solve result (for re-render on zoom).
let uploadBlocks = null;
let lastResult = null;

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

// ---- wiring -------------------------------------------------------------
loadExamples();
addConstraintType("sequence", "Sequence (ordered)");

$("parse-btn").onclick = () =>
  withBusy($("parse-btn"), "Parsing…", async () => {
    const sentence = $("sentence").value.trim();
    if (!sentence) return;
    scenario = await post("/parse", { sentence });
    render();
  });

$("example-select").onchange = async (e) => {
  const name = e.target.value;
  if (!name) return;
  clearAlert();
  try {
    scenario = await getJSON(`/example/${name}`);
    render();
  } catch (err) {
    showAlert(err.message);
  }
};

$("solve-btn").onclick = () =>
  withBusy($("solve-btn"), "Solving…", async () => {
    renderResult(await post("/solve", scenario));
  });

// --- .docx import: /upload (fast scan) then /extract (slow, streamed) ---
$("upload-btn").onclick = () =>
  withBusy($("upload-btn"), "Reading…", async () => {
    const file = $("docx-file").files[0];
    if (!file) {
      showAlert("Choose a .docx file first.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    let r;
    try {
      r = await fetch("/upload", { method: "POST", body: form });
    } catch {
      throw new Error("Could not reach the server — is the Flask app running?");
    }
    const data = await safeJSON(r);
    if (!r.ok) throw new Error((data && (data.message || data.error)) || `Upload failed (${r.status}).`);
    uploadBlocks = data.blocks || null;
    renderUploadSummary(data.coverage || {});
  });

$("add-activity").onclick = () => {
  scenario.activities.push({ id: uniqueActivityId(), duration: 30 });
  render();
};

$("add-constraint").onclick = () => {
  scenario.constraints.push(newConstraint($("add-constraint-type").value));
  render();
};

// Ctrl/Cmd+Enter parses from the textarea.
$("sentence").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("parse-btn").click();
});

// Zoom controls (multi-day Gantt only): slider drives px/min; buttons nudge it.
$("zoom").addEventListener("input", (e) => {
  zoomT = Number(e.target.value) / 100;
  redrawGantt();
});
$("zoom-in").onclick = () => nudgeZoom(+0.12);
$("zoom-out").onclick = () => nudgeZoom(-0.12);
function nudgeZoom(delta) {
  zoomT = Math.min(1, Math.max(0, zoomT + delta));
  $("zoom").value = String(Math.round(zoomT * 100));
  redrawGantt();
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

// ---- rendering ----------------------------------------------------------
function render() {
  $("board").hidden = false;
  renderProject();
  renderDay();
  renderActivities();
  renderConstraints();
}

// Project (multi-day) card: start_date (display only) + horizon_days. Setting
// horizon_days is what makes a scenario "multi-day"; clearing it returns to single-day.
function renderProject() {
  const box = $("project");
  box.innerHTML = "";
  const el = cardShell("constraint");

  const head = document.createElement("div");
  head.className = "card-head";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = scenario.horizon_days != null;
  cb.setAttribute("aria-label", "schedule across multiple days");
  cb.onchange = () => {
    scenario.horizon_days = cb.checked ? (scenario.horizon_days || 7) : null;
    if (!cb.checked) scenario.start_date = scenario.start_date || null;
    render();
  };
  head.append(cb);
  head.append(el_("strong", "Schedule across multiple days", "card-title"));
  el.append(head);

  if (scenario.horizon_days != null) {
    el.append(numField("horizon (days)", scenario.horizon_days, (v) => {
      // 1..365; an empty/invalid entry falls back to a 1-day horizon.
      scenario.horizon_days = Number.isFinite(v) ? Math.min(365, Math.max(1, v)) : 1;
    }));
    el.append(textField("start date (YYYY-MM-DD, optional)", scenario.start_date || "",
      (v) => (scenario.start_date = v.trim() || null)));
    el.append(el_("div",
      "The horizon is the full canvas the solver fits the work into. Start date is display only — bars are labeled with calendar dates when set.",
      "hint"));
  } else {
    el.append(el_("div",
      "Off: the schedule is a single 24-hour day (the original behavior).", "hint"));
  }
  box.append(el);
}

function renderDay() {
  const box = $("day");
  box.innerHTML = "";
  const el = cardShell("constraint");
  const head = document.createElement("div");
  head.className = "card-head";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!scenario.day;
  cb.setAttribute("aria-label", "limit the whole day to a window");
  cb.onchange = () => {
    scenario.day = cb.checked ? { start: "08:00", end: "22:00" } : null;
    render();
  };
  head.append(cb);
  head.append(el_("strong", "Bound the whole day to a window", "card-title"));
  el.append(head);
  if (scenario.day) {
    el.append(textField("start (HH:MM)", scenario.day.start, (v) => (scenario.day.start = v)));
    el.append(textField("end (HH:MM)", scenario.day.end, (v) => (scenario.day.end = v)));
    el.append(el_("div", "Every activity must fit inside this window, and the day starts here.", "hint"));
  }
  box.append(el);
}

function renderActivities() {
  const box = $("activities");
  box.innerHTML = "";
  scenario.activities.forEach((a, i) => {
    const el = cardShell("activity");
    const head = document.createElement("div");
    head.className = "card-head";
    head.append(swatch(i));
    head.append(textInput(a.id, (v) => (a.id = v), "activity id", "card-title"));
    head.append(deleteBtn(() => {
      scenario.activities.splice(i, 1);
      render();
    }));
    el.append(head);
    el.append(numField("duration (min)", a.duration, (v) => (a.duration = v)));

    // Provenance + display (carried end-to-end from a .docx import). Editable name,
    // section breadcrumb, and resource; the read-only `source` lets a human verify
    // the extracted item against the document — the reliability story.
    if (a.label !== undefined)
      el.append(textField("name (label)", a.label || "", (v) => (a.label = v)));
    if (a.section !== undefined)
      el.append(textField("section", a.section || "", (v) => (a.section = v || "")));
    if (a.resource !== undefined)
      el.append(textField("resource", a.resource || "", (v) => (a.resource = v.trim() || null)));
    if (a.source) el.append(el_("small", "“" + a.source + "”"));
    box.append(el);
  });
}

function renderConstraints() {
  const box = $("constraints");
  box.innerHTML = "";
  scenario.constraints.forEach((c, i) => {
    const el = cardShell("constraint" + (c.enabled === false ? " off" : ""));
    if (c.id) el.dataset.cid = c.id; // lets a conflict highlight find this card
    const head = document.createElement("div");
    head.className = "card-head";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = c.enabled !== false;
    cb.setAttribute("aria-label", "enabled");
    cb.onchange = () => {
      c.enabled = cb.checked;
      el.classList.toggle("off", !cb.checked);
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
    if (c.source) el.append(el_("small", "“" + c.source + "”"));
    box.append(el);
  });
}

function constraintFields(c) {
  const f = [];
  if (c.type === "time_window") {
    f.push(activitySelect("activity", c.activity, (v) => (c.activity = v)));
    // earliest/latest_end are "Moments": a bare "HH:MM" (day 0) or {day, time}.
    // The editor reads either shape and writes back the compact one (string for day 0).
    f.push(momentField("earliest", c.earliest, (v) => (c.earliest = v)));
    f.push(momentField("latest end", c.latest_end, (v) => (c.latest_end = v)));
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
// The horizon (minutes) for the current result: the solver's `horizon` for
// multi-day, else the single 24h DAY. Read by hhmm() and the Gantt builder.
let curHorizon = DAY;
// Zoom is a 0..1 dial mapped to a px/min scale (see pxPerMin); collapsed sections.
let zoomT = 0;
const collapsedSections = new Set();

function renderResult(result) {
  lastResult = result;
  curHorizon = result && result.horizon > 0 ? result.horizon : DAY;
  $("result").hidden = false;
  const status = result.status || "?";
  const pill = $("status");
  pill.textContent = status;
  pill.className =
    "pill " + (status === "OPTIMAL" || status === "FEASIBLE" ? "pill-ok" : status === "INFEASIBLE" ? "pill-bad" : "pill-warn");

  const banner = $("banner");
  const tl = $("timeline");
  banner.hidden = true;
  banner.textContent = "";
  tl.innerHTML = "";
  $("conflict").hidden = true;
  $("conflict").innerHTML = "";
  $("notes").hidden = true;
  $("notes").innerHTML = "";
  $("gantt-controls").hidden = true;
  clearConflictHighlights();

  if (status === "INFEASIBLE") {
    banner.hidden = false;
    banner.className = "banner banner-bad";
    banner.textContent =
      "No schedule satisfies all enabled constraints. Try disabling one, or loosen a time window.";
    // The solver MAY explain the clash (another agent adds `conflict`); show it if present.
    if (result.conflict) renderConflict(result.conflict);
    return;
  }
  if (status !== "OPTIMAL" && status !== "FEASIBLE") {
    banner.hidden = false;
    banner.className = "banner banner-warn";
    banner.textContent = "Solver returned: " + status;
    return;
  }
  // Multi-day solver notes (e.g. bucket granularity) — informational.
  if (Array.isArray(result.notes) && result.notes.length) {
    const n = $("notes");
    n.hidden = false;
    n.innerHTML = "";
    for (const msg of result.notes) n.append(el_("div", msg, "note"));
  }
  if (!result.schedule || !result.schedule.length) {
    banner.hidden = false;
    banner.className = "banner";
    banner.textContent = "Solved, but there are no activities to show.";
    return;
  }
  redrawGantt();
}

// Re-render the Gantt from the last result (used by Solve and by the zoom controls).
function redrawGantt() {
  if (!lastResult || !lastResult.schedule || !lastResult.schedule.length) return;
  const tl = $("timeline");
  // Preserve horizontal scroll position across a zoom re-render where possible.
  const prev = tl.querySelector(".gantt-scroll");
  const keepScroll = prev ? prev.scrollLeft : 0;
  tl.innerHTML = "";
  $("gantt-controls").hidden = curHorizon <= DAY; // zoom only matters multi-day
  tl.append(buildGantt(lastResult.schedule));
  const next = tl.querySelector(".gantt-scroll");
  if (next && keepScroll) next.scrollLeft = keepScroll;
}

// Join a schedule item to its activity by id, for label/section/resource.
function activityFor(id) {
  return scenario.activities.find((a) => a.id === id) || null;
}
function rowLabel(item) {
  const a = activityFor(item.id);
  return (a && a.label) || item.id;
}

// Dispatch: single-day keeps the original percent-scaled 24h chart EXACTLY;
// multi-day (horizon > DAY) uses a pixels-per-minute, scrollable, section-grouped chart.
function buildGantt(schedule) {
  return curHorizon > DAY ? buildGanttMulti(schedule) : buildGanttDay(schedule);
}

// --- single-day Gantt: unchanged from the original (percent of a 24h day). ---
function buildGanttDay(schedule) {
  const g = document.createElement("div");
  g.className = "gantt";

  // Hour axis (0..24, ticks every 3h).
  const axis = document.createElement("div");
  axis.className = "gantt-row gantt-axis";
  axis.append(el_("div", "", "gantt-label"));
  const axisTrack = document.createElement("div");
  axisTrack.className = "gantt-track";
  for (let h = 0; h <= 24; h += 3) {
    const t = el_("span", String(h), "tick-label");
    t.style.left = (100 * (h * 60)) / DAY + "%";
    axisTrack.append(t);
  }
  axis.append(axisTrack);
  g.append(axis);

  // One lane per activity, ordered by start time.
  [...schedule]
    .sort((a, b) => a.start - b.start)
    .forEach((item) => {
      const row = document.createElement("div");
      row.className = "gantt-row";
      const label = el_("div", item.id, "gantt-label");
      label.title = item.id;
      row.append(label);

      const track = document.createElement("div");
      track.className = "gantt-track lane";
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.style.left = (100 * item.start) / DAY + "%";
      bar.style.width = Math.max(0.8, (100 * (item.end - item.start)) / DAY) + "%";
      bar.style.background = colorFor(item.id);
      bar.title = `${item.id}: ${hhmm(item.start)}–${hhmm(item.end)}`;
      bar.append(el_("span", `${hhmm(item.start)}–${hhmm(item.end)}`, "bar-time"));
      track.append(bar);
      row.append(track);
      g.append(row);
    });
  return g;
}

// --- multi-day Gantt: a real px/min scale, horizontally scrollable, day ticks,
// and rows grouped under collapsible section headers (collapsing trims the
// visible row count — the virtualization story for ~100 tasks). ---
function buildGanttMulti(schedule) {
  const totalDays = Math.ceil(curHorizon / DAY);
  const pxmin = pxPerMin(totalDays);
  const trackPx = Math.round(curHorizon * pxmin); // full timeline width in px

  // Outer: a horizontally scrollable viewport; inner content is `trackPx` wide.
  const scroll = document.createElement("div");
  scroll.className = "gantt-scroll";
  const g = document.createElement("div");
  g.className = "gantt gantt-multi";
  g.style.width = LABEL_W + trackPx + "px"; // label gutter + the scaled track

  // Day axis: a tick every `step` days (keeps the count readable at any zoom).
  const step = dayTickStep(totalDays, pxmin);
  const axis = document.createElement("div");
  axis.className = "gantt-row gantt-axis";
  axis.append(el_("div", "", "gantt-label"));
  const axisTrack = document.createElement("div");
  axisTrack.className = "gantt-track gantt-axis-track";
  axisTrack.style.width = trackPx + "px";
  for (let d = 0; d <= totalDays; d += step) {
    const t = el_("span", dayTickLabel(d), "tick-label");
    t.style.left = d * DAY * pxmin + "px";
    axisTrack.append(t);
    // A faint vertical gridline at each tick.
    const line = document.createElement("div");
    line.className = "day-gridline";
    line.style.left = d * DAY * pxmin + "px";
    axisTrack.append(line);
  }
  axis.append(axisTrack);
  g.append(axis);

  // Group rows by section (fallback: "(no section)"), preserving first-seen order.
  const sorted = [...schedule].sort((a, b) => a.start - b.start);
  const groups = new Map(); // section -> items[]
  for (const item of sorted) {
    const a = activityFor(item.id);
    const sec = (a && a.section) || "(no section)";
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(item);
  }

  for (const [section, items] of groups) {
    const collapsed = collapsedSections.has(section);
    g.append(sectionHeader(section, items.length, collapsed, trackPx));
    if (collapsed) continue;
    for (const item of items) g.append(ganttBar(item, pxmin, trackPx));
  }

  scroll.append(g);
  return scroll;
}

const LABEL_W = 140; // px label gutter for multi-day rows (wider names from .docx)

// A collapsible section header row; clicking toggles its group's visibility.
function sectionHeader(section, count, collapsed, trackPx) {
  const row = document.createElement("div");
  row.className = "gantt-row gantt-section";
  const head = document.createElement("button");
  head.className = "gantt-section-head";
  head.style.width = LABEL_W + trackPx + "px";
  head.setAttribute("aria-expanded", String(!collapsed));
  head.append(el_("span", collapsed ? "▸" : "▾", "gantt-caret"));
  head.append(el_("span", section, "gantt-section-name"));
  head.append(el_("span", `${count}`, "gantt-section-count"));
  head.onclick = () => {
    if (collapsedSections.has(section)) collapsedSections.delete(section);
    else collapsedSections.add(section);
    redrawGantt();
  };
  row.append(head);
  return row;
}

// One bar row in the multi-day chart, positioned in px against the horizon.
function ganttBar(item, pxmin, trackPx) {
  const row = document.createElement("div");
  row.className = "gantt-row";
  const label = el_("div", rowLabel(item), "gantt-label gantt-label-wide");
  label.title = rowLabel(item);
  row.append(label);

  const track = document.createElement("div");
  track.className = "gantt-track lane lane-plain";
  track.style.width = trackPx + "px";
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.style.left = item.start * pxmin + "px";
  bar.style.width = Math.max(3, (item.end - item.start) * pxmin) + "px";
  bar.style.background = colorFor(item.id);
  const span = `${hhmm(item.start)}–${hhmm(item.end)}`;
  bar.title = `${rowLabel(item)}: ${span}`;
  bar.append(el_("span", span, "bar-time"));
  track.append(bar);
  row.append(track);
  return row;
}

// Map the 0..1 zoom dial to pixels-per-minute. At zoom 0 the whole horizon fits
// the viewport (~760px of track); zooming in scales up to a readable density.
function pxPerMin(totalDays) {
  const fitWidth = 760; // approx track width inside the panel
  const fitPxMin = fitWidth / curHorizon; // px/min that fits everything
  // A comfortable "fully zoomed in" density: ~2.5px per minute (≈ a day spans wide).
  const maxPxMin = Math.max(fitPxMin * 2, 2.5);
  return fitPxMin + (maxPxMin - fitPxMin) * zoomT;
}

// Choose a day-tick interval so we never draw hundreds of labels.
function dayTickStep(totalDays, pxmin) {
  const dayPx = DAY * pxmin;
  const minLabelPx = 56; // keep ~56px between day labels
  const step = Math.ceil(minLabelPx / Math.max(dayPx, 1));
  // Round up to a "nice" interval (1, 2, 5, 7, 10, 14, 30, …).
  for (const nice of [1, 2, 5, 7, 10, 14, 30, 60, 90]) {
    if (step <= nice) return nice;
  }
  return Math.max(1, Math.ceil(totalDays / 12));
}

// A day tick's label: a calendar date if start_date is known, else "Day N".
function dayTickLabel(d) {
  const sd = lastResult && lastResult.start_date;
  if (sd) {
    const base = new Date(sd + "T00:00:00");
    if (!isNaN(base)) {
      base.setDate(base.getDate() + d);
      return base.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  }
  return "Day " + d;
}

// Day-aware time label: "D{day} HH:MM" in multi-day, plain "HH:MM" single-day.
function hhmm(min) {
  const t = min % DAY;
  const h = Math.floor(t / 60);
  const m = t % 60;
  const clock = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (curHorizon > DAY) return `D${Math.floor(min / DAY)} ${clock}`;
  return clock;
}

// ---- conflict (INFEASIBLE explanation) ----------------------------------
// Render the solver's conflict object (if any) and outline the offending cards.
function renderConflict(conflict) {
  const box = $("conflict");
  box.hidden = false;
  box.innerHTML = "";
  const kind = conflict.kind ? conflict.kind : "unknown";
  box.append(el_("div", conflict.message || "These constraints clash.", "conflict-msg"));
  box.append(el_("div", "Conflict type: " + kind, "conflict-kind"));
  const list = document.createElement("ul");
  list.className = "conflict-list";
  for (const c of conflict.constraints || []) {
    const li = document.createElement("li");
    const name = c.label || c.id || c.type || "constraint";
    li.append(el_("span", name, "conflict-name"));
    if (c.type) li.append(badge(c.type));
    if (c.source) li.append(el_("small", "“" + c.source + "”"));
    list.append(li);
    highlightConstraint(c.id);
  }
  if (list.childElementCount) box.append(list);
}

// Find a rendered constraint card by id and flag it (red border).
function highlightConstraint(id) {
  if (!id) return;
  const card = document.querySelector(`.card[data-cid="${cssEscape(id)}"]`);
  if (card) card.classList.add("conflict-hit");
}
function clearConflictHighlights() {
  document.querySelectorAll(".card.conflict-hit").forEach((c) => c.classList.remove("conflict-hit"));
}
// Minimal CSS.escape fallback (ids here are simple, but stay safe).
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

// ---- .docx import: summary, streamed extraction, coverage review --------
// After /upload: show a quick scan summary + the "Build schedule" button.
// `coverage` = { requirement_ids[], sections[], n_blocks, n_requirements, n_dates, n_shall }.
function renderUploadSummary(coverage) {
  const box = $("upload-summary");
  box.hidden = false;
  box.innerHTML = "";

  const stats = document.createElement("div");
  stats.className = "stat-row";
  stats.append(stat(coverage.n_requirements ?? 0, "requirements"));
  stats.append(stat((coverage.sections || []).length, "sections"));
  stats.append(stat(coverage.n_dates ?? 0, "dates"));
  stats.append(stat(coverage.n_shall ?? 0, "“shall” statements"));
  box.append(stats);

  const build = document.createElement("button");
  build.id = "build-btn";
  build.className = "btn btn-primary";
  build.textContent = "Build schedule →";
  build.onclick = () => startExtract(build);
  box.append(build);
  box.append(el_("div",
    "Extraction reads each section with the local model and can take a few minutes.", "hint"));
}

// Stream /extract via fetch + a reader (EventSource can't POST). Shows progress,
// then on `done` loads the scenario into the cards and renders the review panel.
function startExtract(btn) {
  if (!uploadBlocks) {
    showAlert("Upload a .docx first.");
    return;
  }
  clearAlert();
  btn.disabled = true;
  const prog = $("extract-progress");
  prog.hidden = false;
  setProgress(0, 0, "Starting…");

  withBusy(btn, "Building…", async () => {
    let resp;
    try {
      resp = await fetch("/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: uploadBlocks }),
      });
    } catch {
      throw new Error("Could not reach the server — is the Flask app running?");
    }
    if (!resp.ok || !resp.body) {
      const data = await safeJSON(resp);
      throw new Error((data && (data.message || data.error)) || `Extract failed (${resp.status}).`);
    }
    await readSSE(resp.body, onExtractEvent);
  }).finally(() => {
    prog.hidden = true;
  });
}

// One SSE event from /extract: progress (many) then a terminal done|error.
function onExtractEvent(ev) {
  if (ev.type === "progress") {
    setProgress(ev.i, ev.n, ev.label || "");
  } else if (ev.type === "error") {
    showAlert(ev.error || "Extraction failed.");
  } else if (ev.type === "done") {
    setProgress(ev.coverage ? ev.coverage.n_extracted : 1, 1, "Done");
    scenario = ev.scenario || { activities: [], constraints: [] };
    collapsedSections.clear();
    render();
    renderReview(ev.coverage || {}, ev.warnings || []);
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function setProgress(i, n, label) {
  const pct = n > 0 ? Math.round((i / n) * 100) : 0;
  $("extract-progress-fill").style.width = pct + "%";
  $("extract-progress-count").textContent = n > 0 ? `${i}/${n}` : "";
  $("extract-progress-label").textContent = label || "Extracting…";
}

// Read a text/event-stream body, parsing `data: {json}` lines into events.
async function readSSE(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line; each carries one or more data: lines.
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore a malformed frame; the terminal event still arrives */
      }
    }
  }
}

// The MANDATORY review panel: did the model account for every requirement, and
// what did it have to guess? `coverage` = { requirement_ids_in_doc[], n_in_doc,
// n_extracted, not_extracted[], defaulted_duration[], dangling_references[],
// n_activities, n_constraints }.
function renderReview(coverage, warnings) {
  const panel = $("review");
  const box = $("review-body");
  panel.hidden = false;
  box.innerHTML = "";

  box.append(el_("p",
    "The local model drafted this from your document. It may have invented or guessed " +
    "durations and could miss a requirement, so verify each item against its source " +
    "(shown on every activity card below) before solving.", "review-note"));

  const stats = document.createElement("div");
  stats.className = "stat-row";
  stats.append(stat(coverage.n_in_doc ?? 0, "in document"));
  stats.append(stat(coverage.n_extracted ?? 0, "extracted"));
  stats.append(stat(coverage.n_activities ?? 0, "activities"));
  stats.append(stat(coverage.n_constraints ?? 0, "constraints"));
  box.append(stats);

  const notExtracted = coverage.not_extracted || [];
  const defaulted = coverage.defaulted_duration || [];
  const dangling = coverage.dangling_references || [];

  // Dropped requirements are the headline failure — red.
  if (notExtracted.length) {
    box.append(reviewFlag("bad",
      `${notExtracted.length} requirement(s) in the document were NOT extracted`,
      notExtracted));
  } else {
    box.append(reviewFlag("ok", "Every requirement in the document was extracted", []));
  }
  // Guessed durations — amber, verify against the source.
  if (defaulted.length) {
    box.append(reviewFlag("warn",
      `${defaulted.length} activity(ies) had no stated duration — duration was guessed`,
      defaulted));
  }
  // Dangling references: a constraint points at a missing activity.
  if (dangling.length) {
    box.append(reviewFlag("bad",
      `${dangling.length} constraint reference(s) point at a missing activity`,
      dangling.map((d) => `${d.constraint} → ${d.missing}`)));
  }
  // Free-form pipeline warnings.
  if (warnings && warnings.length) {
    const wrap = document.createElement("div");
    wrap.className = "review-flag review-warn";
    wrap.append(el_("div", "Notes from extraction", "review-flag-title"));
    const ul = document.createElement("ul");
    ul.className = "review-pills";
    for (const w of warnings) {
      const li = document.createElement("li");
      li.textContent = w;
      ul.append(li);
    }
    wrap.append(ul);
    box.append(wrap);
  }
}

// A colored review block: title + a list of pills (ids/items).
function reviewFlag(level, title, items) {
  const wrap = document.createElement("div");
  wrap.className = "review-flag review-" + level;
  wrap.append(el_("div", title, "review-flag-title"));
  if (items && items.length) {
    const ul = document.createElement("ul");
    ul.className = "review-pills";
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

// A small "<big number> <label>" stat tile.
function stat(value, label) {
  const wrap = el_("div", "", "stat");
  wrap.append(el_("span", String(value), "stat-num"));
  wrap.append(el_("span", label, "stat-lbl"));
  return wrap;
}

// ---- tiny DOM helpers ---------------------------------------------------
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

// --- Moment helpers: round-trip a time field that may be "HH:MM" or {day, time}. ---
// Read any stored Moment into a uniform {day, time}; null/"" -> null.
function readMoment(m) {
  if (m == null || m === "") return null;
  if (typeof m === "string") return { day: 0, time: m };
  return { day: Number(m.day) || 0, time: m.time || "" };
}
// Write back the COMPACT shape: day 0 -> a bare "HH:MM" string (preserves the
// single-day IR); day>0 -> {day, time}. Empty time clears the whole Moment.
function writeMoment(day, time) {
  const t = (time || "").trim();
  if (!t) return null;
  const d = Math.max(0, parseInt(day, 10) || 0);
  return d === 0 ? t : { day: d, time: t };
}

// A Moment editor: an optional "day" number input beside the "HH:MM" text input.
// `value` is the stored Moment (string|object|null); `onChange(next)` gets the
// compact shape back. Editing either field re-emits the combined value.
function momentField(label, value, onChange) {
  const m = readMoment(value) || { day: 0, time: "" };
  const wrap = document.createElement("label");
  wrap.className = "field field-moment";
  wrap.append(el_("span", label, "field-lbl"));

  const dayInp = document.createElement("input");
  dayInp.type = "number";
  dayInp.min = "0";
  dayInp.value = m.day || 0;
  dayInp.className = "moment-day";
  dayInp.setAttribute("aria-label", label + " day");

  const dayPrefix = el_("span", "day", "moment-prefix");

  const timeInp = document.createElement("input");
  timeInp.type = "text";
  timeInp.value = m.time || "";
  timeInp.placeholder = "HH:MM";
  timeInp.className = "moment-time";
  timeInp.setAttribute("aria-label", label + " time");

  const emit = () => onChange(writeMoment(dayInp.value, timeInp.value));
  dayInp.oninput = emit;
  timeInp.oninput = emit;

  wrap.append(dayPrefix, dayInp, timeInp);
  return wrap;
}
function activitySelect(label, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(el_("span", label, "field-lbl"));
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
  sel.onchange = () => onChange(sel.value);
  wrap.append(sel);
  return wrap;
}
// Checkbox list for a no_overlap subset; `selected` is the current id array.
// Includes any selected ids that no longer exist as activities, flagged "(missing: …)".
function activityChecklist(selected, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(el_("span", "activities", "field-lbl"));
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
    list.append(el_("span", "No activities to choose from.", "hint"));
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
  row.append(el_("span", label));
  return row;
}
// Ordered, editable list of activity slots for a sequence; top-to-bottom is array order.
// `steps` is the current id array; each row picks its activity, with move/remove controls.
function sequenceEditor(steps, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(el_("span", "steps (in order)", "field-lbl"));
  const list = document.createElement("div");
  list.className = "sequence";
  const update = (next) => {
    onChange(next);
    render();
  };
  steps.forEach((id, i) => {
    const row = document.createElement("div");
    row.className = "seq-step";
    row.append(el_("span", String(i + 1) + ".", "seq-num"));
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
  if (!steps.length) list.append(el_("span", "No steps yet.", "hint"));
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
function el_(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
