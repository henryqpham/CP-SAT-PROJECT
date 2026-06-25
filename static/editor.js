// editor.js — the editable IR board (Agent C's area).
//   activity + constraint cards · typed per-type fields · Moment editor ·
//   sequence editor · no_overlap checklist. Mutates `scenario` in place; call
//   render() (core) to repaint. initEditor() wires the add buttons.
//
// Design intent: this board is the "review the rules, don't trust the LLM"
// surface. Every card shows its type, its editable label, its source phrase
// (provenance), and — advisory only — flags malformed times and dangling
// activity references so a human can spot a bad extraction before solving.
// Validation never blocks /solve (the backend validates too); it just makes the
// problem visible.

// "HH:MM" with HH 00..24, MM 00..59, and not past 24:00 — mirrors models.py's
// _HHMM so the dashboard flags exactly what the backend would reject.
const HHMM_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;
// Validate a time string for a Moment/day field. `role` is "earliest" |
// "latest_end" | "day" — only "earliest" rejects the 24:00 end-of-day sentinel.
// Returns null when valid, else a short human message.
function timeError(time, role) {
  const t = (time || "").trim();
  if (!t) return null; // empty == "no bound" (a valid, optional state)
  if (!HHMM_RE.test(t) || t > "24:00") return "Use HH:MM (00:00–24:00).";
  if (role === "earliest" && t === "24:00") return "Start can’t be 24:00 — use day +1 at 00:00.";
  return null;
}
// Activity ids that exist right now, for reference-checking.
function knownActivityIds() {
  return scenario.activities.map((a) => a.id);
}

function initEditor() {
  $("add-activity").onclick = () => {
    scenario.activities.push({ id: uniqueActivityId(), duration: 30 });
    render();
  };
  $("add-constraint").onclick = () => {
    scenario.constraints.push(newConstraint($("add-constraint-type").value));
    render();
  };
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
    const dateField = textField("start date (YYYY-MM-DD, optional)", scenario.start_date || "",
      (v) => (scenario.start_date = v.trim() || null));
    // Advisory ISO-date flag (display only; never blocks solving).
    const dateInp = dateField.querySelector("input");
    const flagDate = () => {
      const v = dateInp.value.trim();
      setInvalid(dateInp, v && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? "Use YYYY-MM-DD." : null);
    };
    dateInp.addEventListener("input", flagDate);
    flagDate();
    el.append(dateField);
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
    el.append(timeField("start (HH:MM)", scenario.day.start, "day", (v) => (scenario.day.start = v)));
    el.append(timeField("end (HH:MM)", scenario.day.end, "day", (v) => (scenario.day.end = v)));
    el.append(el_("div", "Every activity must fit inside this window, and the day starts here.", "hint"));
  }
  box.append(el);
}

function renderActivities() {
  const box = $("activities");
  box.innerHTML = "";
  if (!scenario.activities.length) {
    box.append(el_("div", "No activities yet — add one to start.", "hint"));
    return;
  }
  scenario.activities.forEach((a, i) => {
    const el = cardShell("activity");
    el.dataset.aid = a.id; // lets the coverage panel scroll/flash this activity card
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
    if (a.source) el.append(sourceLine(a.source));
    box.append(el);
  });
}

function renderConstraints() {
  const box = $("constraints");
  box.innerHTML = "";
  if (!scenario.constraints.length) {
    box.append(el_("div", "No constraints yet — pick a type above and add one.", "hint"));
    return;
  }
  scenario.constraints.forEach((c, i) => {
    const el = cardShell("constraint" + (c.enabled === false ? " off" : ""));
    if (c.id) el.dataset.cid = c.id; // lets a conflict highlight find this card
    const head = document.createElement("div");
    head.className = "card-head";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = c.enabled !== false;
    cb.setAttribute("aria-label", "enabled");
    cb.title = "Enable / disable this rule (disabled rules are skipped when solving)";
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

    // Advisory: name any activity ids this constraint points at that no longer
    // exist. The per-field selects also flag these, but a card-level banner makes
    // a broken reference unmissable (the "don't trust the LLM" anchor).
    const dangling = danglingRefs(c);
    if (dangling.length) el.append(danglingWarning(dangling));

    for (const f of constraintFields(c)) el.append(f);
    if (c.source) el.append(sourceLine(c.source));
    box.append(el);
  });
}

// Collect activity ids a constraint references that aren't in the activity list.
function danglingRefs(c) {
  const ids = knownActivityIds();
  const refs = [];
  const add = (v) => { if (v) refs.push(v); };
  if (c.type === "time_window") add(c.activity);
  else if (c.type === "precedence") { add(c.before); add(c.after); }
  else if (c.type === "no_overlap") { if (Array.isArray(c.activities)) c.activities.forEach(add); }
  else if (c.type === "sequence") { if (Array.isArray(c.activities)) c.activities.forEach(add); }
  else if (c.type === "conditional") {
    add(c.when && c.when.activity);
    add(c.then && c.then.set_duration && c.then.set_duration.activity);
  }
  // Unique, only the ones that don't resolve.
  return [...new Set(refs)].filter((id) => !ids.includes(id));
}

function constraintFields(c) {
  const f = [];
  if (c.type === "time_window") {
    f.push(activitySelect("activity", c.activity, (v) => (c.activity = v)));
    // earliest/latest_end are "Moments": a bare "HH:MM" (day 0) or {day, time}.
    // The editor reads either shape and writes back the compact one (string for day 0).
    f.push(momentField("earliest", c.earliest, "earliest", (v) => (c.earliest = v)));
    f.push(momentField("latest end", c.latest_end, "latest_end", (v) => (c.latest_end = v)));
  } else if (c.type === "precedence") {
    f.push(activitySelect("before", c.before, (v) => (c.before = v)));
    f.push(el_("div", "↓ ends before the next one starts", "hint hint-flow"));
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

// --- Moment helpers: round-trip a time field that may be "HH:MM" or {day, time}. ---
// Read any stored Moment into a uniform {day, time}; null/"" -> null.
function readMoment(m) {
  if (m == null || m === "") return null;
  if (typeof m === "string") return { day: 0, time: m };
  return { day: Number(m.day) || 0, time: m.time || "" };
}
// Write back the COMPACT shape: day 0 -> a bare "HH:MM" string (preserves the
// single-day IR); day>0 -> {day, time}. Empty time clears the whole Moment.
// CONTRACT: a day-0 Moment MUST serialize to a bare string (smoke test asserts it).
function writeMoment(day, time) {
  const t = (time || "").trim();
  if (!t) return null;
  const d = Math.max(0, parseInt(day, 10) || 0);
  return d === 0 ? t : { day: d, time: t };
}

// A Moment editor: a "day" stepper beside the "HH:MM" text input. `value` is the
// stored Moment (string|object|null); `onChange(next)` gets the compact shape
// back. `role` ("earliest" | "latest_end") drives validation (24:00 rule).
// Visually distinguishes day 0 ("today") from day N, and flags a bad HH:MM.
function momentField(label, value, role, onChange) {
  const m = readMoment(value) || { day: 0, time: "" };
  const wrap = document.createElement("label");
  wrap.className = "field field-moment";
  wrap.append(el_("span", label, "field-lbl"));

  const ctl = document.createElement("span");
  ctl.className = "moment-ctl";

  const dayPrefix = el_("span", "day", "moment-prefix");
  const dayInp = document.createElement("input");
  dayInp.type = "number";
  dayInp.min = "0";
  dayInp.value = m.day || 0;
  dayInp.className = "moment-day";
  dayInp.setAttribute("aria-label", label + " day");

  // "today" badge for day 0, so a multi-day Moment reads differently at a glance.
  const dayTag = el_("span", "", "moment-daytag");

  const timeInp = document.createElement("input");
  timeInp.type = "text";
  timeInp.value = m.time || "";
  timeInp.placeholder = "HH:MM";
  timeInp.className = "moment-time";
  timeInp.setAttribute("aria-label", label + " time");

  const msg = el_("div", "", "field-msg");

  const reflectDay = () => {
    const d = Math.max(0, parseInt(dayInp.value, 10) || 0);
    wrap.classList.toggle("is-today", d === 0);
    dayTag.textContent = d === 0 ? "today" : "+" + d;
  };
  const validate = () => {
    const err = timeError(timeInp.value, role);
    setInvalid(timeInp, err);
    msg.textContent = err || "";
    msg.hidden = !err;
  };
  const emit = () => {
    reflectDay();
    validate();
    onChange(writeMoment(dayInp.value, timeInp.value));
  };
  dayInp.oninput = emit;
  timeInp.oninput = emit;

  ctl.append(dayPrefix, dayInp, dayTag, timeInp);
  wrap.append(ctl);
  wrap.append(msg);
  reflectDay();
  validate();
  return wrap;
}

// A plain "HH:MM" time field (no day part) with the same advisory validation —
// used by the day-window editor. `role` is "day" | "earliest" | "latest_end".
function timeField(label, value, role, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(el_("span", label, "field-lbl"));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value || "";
  inp.placeholder = "HH:MM";
  inp.setAttribute("aria-label", label);
  const msg = el_("div", "", "field-msg");
  const validate = () => {
    const err = timeError(inp.value, role);
    setInvalid(inp, err);
    msg.textContent = err || "";
    msg.hidden = !err;
  };
  inp.oninput = () => { validate(); onChange(inp.value); };
  wrap.append(inp);
  wrap.append(msg);
  validate();
  return wrap;
}

function activitySelect(label, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  if (label) wrap.append(el_("span", label, "field-lbl"));
  const sel = document.createElement("select");
  const ids = knownActivityIds();
  const missing = value && !ids.includes(value);
  if (missing) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = `(missing: ${value})`;
    opt.disabled = true;
    opt.selected = true;
    sel.append(opt);
    sel.classList.add("input-invalid"); // flag a dangling reference at the field
  }
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    if (id === value) opt.selected = true;
    sel.append(opt);
  }
  if (!ids.length && !missing) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no activities)";
    opt.disabled = true;
    opt.selected = true;
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
  wrap.className = "field field-top";
  wrap.append(el_("span", "activities", "field-lbl"));
  const list = document.createElement("div");
  list.className = "checklist";
  const ids = knownActivityIds();
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
    list.append(checkboxRow(id, `(missing: ${id})`, true, (on) => toggle(id, on), true));
  }
  if (!ids.length && !dangling.length)
    list.append(el_("span", "No activities to choose from.", "hint"));
  wrap.append(list);
  return wrap;
}
function checkboxRow(value, label, checked, onChange, missing) {
  const row = document.createElement("label");
  row.className = "check" + (missing ? " check-missing" : "");
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
  wrap.className = "field field-top";
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
    const moves = document.createElement("span");
    moves.className = "seq-moves";
    moves.append(moveBtn("▲", "Move up", i === 0, () => {
      const next = steps.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      update(next);
    }));
    moves.append(moveBtn("▼", "Move down", i === steps.length - 1, () => {
      const next = steps.slice();
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      update(next);
    }));
    row.append(moves);
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

// --- small shared bits ---------------------------------------------------
// Toggle the shared .input-invalid flag on an input and set a tooltip.
function setInvalid(inp, msg) {
  inp.classList.toggle("input-invalid", !!msg);
  if (msg) inp.title = msg;
  else inp.removeAttribute("title");
}
// The read-only provenance line: the exact source phrase an item came from.
function sourceLine(text) {
  const s = el_("small", "", "source-line");
  s.append(el_("span", "source", "source-tag"));
  s.append(el_("span", "“" + text + "”", "source-text"));
  return s;
}
// A card-level advisory banner naming activity ids a constraint references that
// no longer exist (advisory only — never blocks solving).
function danglingWarning(ids) {
  const d = el_("div", "", "dangling");
  const label = ids.length === 1 ? "Missing activity: " : "Missing activities: ";
  d.append(el_("span", "⚠ " + label, "dangling-lead"));
  d.append(el_("span", ids.join(", "), "dangling-ids"));
  return d;
}
