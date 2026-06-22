// Dashboard: sentence -> /parse (or Load example) -> editable cards -> /solve -> 24h timeline.
let scenario = { activities: [], constraints: [] };

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
  renderActivities();
  renderConstraints();
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
    box.append(el);
  });
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
    f.push(textField("earliest (HH:MM)", c.earliest || "", (v) => (c.earliest = v || null)));
    f.push(textField("latest end (HH:MM)", c.latest_end || "", (v) => (c.latest_end = v || null)));
  } else if (c.type === "precedence") {
    f.push(activitySelect("before", c.before, (v) => (c.before = v)));
    f.push(activitySelect("after", c.after, (v) => (c.after = v)));
  } else if (c.type === "no_overlap") {
    f.push(el_("div", "Applies to all activities.", "hint"));
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
function renderResult(result) {
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

  if (status === "INFEASIBLE") {
    banner.hidden = false;
    banner.className = "banner banner-bad";
    banner.textContent =
      "No schedule satisfies all enabled constraints. Try disabling one, or loosen a time window.";
    return;
  }
  if (status !== "OPTIMAL" && status !== "FEASIBLE") {
    banner.hidden = false;
    banner.className = "banner banner-warn";
    banner.textContent = "Solver returned: " + status;
    return;
  }
  if (!result.schedule || !result.schedule.length) {
    banner.hidden = false;
    banner.className = "banner";
    banner.textContent = "Solved, but there are no activities to show.";
    return;
  }
  tl.append(buildGantt(result.schedule));
}

function buildGantt(schedule) {
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

function hhmm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
