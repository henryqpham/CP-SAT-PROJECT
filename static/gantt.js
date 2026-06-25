// gantt.js — the result area (Agent A's area).
//   renderResult() draws the solver outcome: a single-day percent-scaled chart,
//   a multi-day px/min scrollable timeline grouped by section, the INFEASIBLE
//   conflict explanation, and solver notes. initGantt() wires the zoom controls.
//
//   The multi-day timeline is built to stay readable at ~100 tasks over weeks:
//   a real pixels-per-minute scale with smooth zoom + horizontal scroll, day
//   gridlines with heavier week markers + date labels, a sticky label gutter,
//   collapsible section groups with an expand/collapse-all affordance, subtle
//   row striping, and a single reused hover tooltip (label / section / source /
//   span). The single-day chart keeps its original percent-of-24h math verbatim.

const LABEL_W = 140; // px label gutter for multi-day rows (wider names from .docx)
const WEEK_DAYS = 7; // a "week" gridline lands every 7 days

// ---- one reused hover tooltip node (built lazily, positioned on the fly) ----
// A single node is far cheaper than a title-attribute per bar at ~100 rows and
// lets long source text wrap and stay readable. Degrades to no-op if absent.
let ganttTip = null;
function ensureTip() {
  if (ganttTip && document.body.contains(ganttTip)) return ganttTip;
  ganttTip = document.createElement("div");
  ganttTip.className = "gantt-tip";
  ganttTip.hidden = true;
  document.body.append(ganttTip);
  return ganttTip;
}
function showTip(html, x, y) {
  const tip = ensureTip();
  tip.innerHTML = html;
  tip.hidden = false;
  positionTip(x, y);
}
function positionTip(x, y) {
  if (!ganttTip || ganttTip.hidden) return;
  // Measure, then clamp inside the viewport so the tip never runs off-screen.
  const pad = 12;
  const w = ganttTip.offsetWidth;
  const h = ganttTip.offsetHeight;
  let left = x + 14;
  let top = y + 16;
  if (left + w + pad > window.innerWidth) left = x - w - 14;
  if (left < pad) left = pad;
  if (top + h + pad > window.innerHeight) top = y - h - 16;
  if (top < pad) top = pad;
  ganttTip.style.left = left + "px";
  ganttTip.style.top = top + "px";
}
function hideTip() {
  if (ganttTip) ganttTip.hidden = true;
}
// Attach the reusable tooltip to a bar; `tipHTML` is prebuilt, escaped markup.
function wireTip(bar, tipHTML) {
  bar.addEventListener("mouseenter", (e) => showTip(tipHTML, e.clientX, e.clientY));
  bar.addEventListener("mousemove", (e) => positionTip(e.clientX, e.clientY));
  bar.addEventListener("mouseleave", hideTip);
}
function escHTML(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function initGantt() {
  // Zoom controls (multi-day Gantt only): slider drives px/min; buttons nudge it.
  $("zoom").addEventListener("input", (e) => {
    zoomT = Number(e.target.value) / 100;
    redrawGantt();
  });
  $("zoom-in").onclick = () => nudgeZoom(+0.12);
  $("zoom-out").onclick = () => nudgeZoom(-0.12);
  // Hide the tooltip on scroll/resize so it can't strand mid-air.
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
}
function nudgeZoom(delta) {
  zoomT = Math.min(1, Math.max(0, zoomT + delta));
  $("zoom").value = String(Math.round(zoomT * 100));
  redrawGantt();
}

function renderResult(result) {
  lastResult = result;
  curHorizon = result && result.horizon > 0 ? result.horizon : DAY;
  $("result").hidden = false;
  hideTip();
  const status = result.status || "?";
  const pill = $("status");
  pill.textContent = status;
  pill.className =
    "pill " + (status === "OPTIMAL" || status === "FEASIBLE" ? "pill-ok" : status === "INFEASIBLE" ? "pill-bad" : "pill-warn");

  const banner = $("banner");
  const tl = $("timeline");
  banner.hidden = true;
  banner.textContent = "";
  banner.className = "banner";
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
  hideTip();
  // Preserve horizontal scroll position across a zoom re-render where possible.
  const prev = tl.querySelector(".gantt-scroll");
  const keepScroll = prev ? prev.scrollLeft : 0;
  tl.innerHTML = "";
  $("gantt-controls").hidden = curHorizon <= DAY; // zoom only matters multi-day
  tl.append(buildGantt(lastResult.schedule));
  const next = tl.querySelector(".gantt-scroll");
  if (next && keepScroll) next.scrollLeft = keepScroll;
}

// Dispatch: single-day keeps the original percent-scaled 24h chart EXACTLY;
// multi-day (horizon > DAY) uses a pixels-per-minute, scrollable, section-grouped chart.
function buildGantt(schedule) {
  return curHorizon > DAY ? buildGanttMulti(schedule) : buildGanttDay(schedule);
}

// --- single-day Gantt: unchanged scheduling math (percent of a 24h day). ---
// Positions are byte-identical to the original; only presentational hooks (a
// hover tooltip, a striping class) were added — the lake example renders the same.
function buildGanttDay(schedule) {
  const g = document.createElement("div");
  g.className = "gantt gantt-day";

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
    .forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "gantt-row" + (i % 2 ? " gantt-row-alt" : "");
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
      bar.append(el_("span", `${hhmm(item.start)}–${hhmm(item.end)}`, "bar-time"));
      wireTip(bar, tipHTML(item));
      track.append(bar);
      row.append(track);
      g.append(row);
    });
  return g;
}

// --- multi-day Gantt: a real px/min scale, horizontally scrollable, day +
// heavier week gridlines with date labels, rows grouped under collapsible
// section headers (collapsing trims the visible row count), subtle striping. ---
function buildGanttMulti(schedule) {
  const totalDays = Math.ceil(curHorizon / DAY);
  const pxmin = pxPerMin(totalDays);
  const trackPx = Math.round(curHorizon * pxmin); // full timeline width in px
  const fullW = LABEL_W + trackPx;

  // Group rows by section (fallback: "(no section)"), preserving first-seen order.
  const sorted = [...schedule].sort((a, b) => a.start - b.start);
  const groups = new Map(); // section -> items[]
  for (const item of sorted) {
    const a = activityFor(item.id);
    const sec = (a && a.section) || "(no section)";
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(item);
  }

  // Outer: a horizontally scrollable viewport; inner content is `fullW` wide.
  const scroll = document.createElement("div");
  scroll.className = "gantt-scroll";
  const g = document.createElement("div");
  g.className = "gantt gantt-multi";
  g.style.width = fullW + "px";

  // Expand/collapse-all affordance — handy when there are many sections.
  g.append(buildSectionToolbar(groups, fullW));

  // Day axis: a tick every `step` days (keeps the count readable at any zoom),
  // with date (or "Day N") labels. The actual gridlines are drawn full-height
  // as a background layer per row so they read across the whole chart.
  const step = dayTickStep(totalDays, pxmin);
  const axis = document.createElement("div");
  axis.className = "gantt-row gantt-axis";
  axis.append(el_("div", "", "gantt-label"));
  const axisTrack = document.createElement("div");
  axisTrack.className = "gantt-track gantt-axis-track";
  axisTrack.style.width = trackPx + "px";
  for (let d = 0; d <= totalDays; d += step) {
    const isWeek = d % WEEK_DAYS === 0;
    const left = d * DAY * pxmin;
    const t = el_("span", dayTickLabel(d), "tick-label" + (isWeek ? " tick-week" : ""));
    t.style.left = left + "px";
    axisTrack.append(t);
    const line = document.createElement("div");
    line.className = "day-gridline" + (isWeek ? " week-gridline" : "");
    line.style.left = left + "px";
    axisTrack.append(line);
  }
  axis.append(axisTrack);
  g.append(axis);

  // Precompute the gridline x-positions once; every lane reuses them so the
  // grid reads vertically across the whole chart without re-deriving per row.
  const gridXs = [];
  for (let d = 0; d <= totalDays; d += step) {
    gridXs.push({ x: d * DAY * pxmin, week: d % WEEK_DAYS === 0 });
  }

  let rowIdx = 0;
  for (const [section, items] of groups) {
    const collapsed = collapsedSections.has(section);
    g.append(sectionHeader(section, items.length, collapsed, fullW));
    if (collapsed) continue;
    for (const item of items) {
      g.append(ganttBar(item, pxmin, trackPx, gridXs, rowIdx % 2 === 1));
      rowIdx++;
    }
  }

  scroll.append(g);
  return scroll;
}

// A small toolbar above the chart: total task count + expand/collapse-all.
function buildSectionToolbar(groups, fullW) {
  const bar = document.createElement("div");
  bar.className = "gantt-toolbar";
  bar.style.minWidth = fullW + "px";

  let total = 0;
  for (const items of groups.values()) total += items.length;
  const summary = el_(
    "span",
    `${total} task${total === 1 ? "" : "s"} · ${groups.size} section${groups.size === 1 ? "" : "s"}`,
    "gantt-toolbar-summary"
  );
  bar.append(summary);

  const allCollapsed = [...groups.keys()].every((s) => collapsedSections.has(s));
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "gantt-toolbar-btn";
  toggle.textContent = allCollapsed ? "Expand all" : "Collapse all";
  toggle.onclick = () => {
    if (allCollapsed) {
      for (const s of groups.keys()) collapsedSections.delete(s);
    } else {
      for (const s of groups.keys()) collapsedSections.add(s);
    }
    redrawGantt();
  };
  bar.append(toggle);
  return bar;
}

// A collapsible section header row; clicking toggles its group's visibility.
function sectionHeader(section, count, collapsed, fullW) {
  const row = document.createElement("div");
  row.className = "gantt-row gantt-section";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "gantt-section-head";
  head.style.width = fullW + "px";
  head.setAttribute("aria-expanded", String(!collapsed));
  head.append(el_("span", collapsed ? "▸" : "▾", "gantt-caret"));
  head.append(el_("span", section, "gantt-section-name"));
  const label = count === 1 ? "1 task" : `${count} tasks`;
  head.append(el_("span", label, "gantt-section-count"));
  head.onclick = () => {
    if (collapsedSections.has(section)) collapsedSections.delete(section);
    else collapsedSections.add(section);
    redrawGantt();
  };
  row.append(head);
  return row;
}

// One bar row in the multi-day chart, positioned in px against the horizon.
// Gridlines are painted into the lane (behind the bar) so the day/week grid
// reads vertically across every row, not just the axis.
function ganttBar(item, pxmin, trackPx, gridXs, alt) {
  const row = document.createElement("div");
  row.className = "gantt-row" + (alt ? " gantt-row-alt" : "");
  const label = el_("div", rowLabel(item), "gantt-label gantt-label-wide");
  label.title = rowLabel(item);
  row.append(label);

  const track = document.createElement("div");
  track.className = "gantt-track lane lane-plain";
  track.style.width = trackPx + "px";

  // Background gridlines for this lane (cheap absolutely-positioned divs).
  if (gridXs) {
    for (const gx of gridXs) {
      const line = document.createElement("div");
      line.className = "lane-gridline" + (gx.week ? " week-gridline" : "");
      line.style.left = gx.x + "px";
      track.append(line);
    }
  }

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.style.left = item.start * pxmin + "px";
  bar.style.width = Math.max(3, (item.end - item.start) * pxmin) + "px";
  bar.style.background = colorFor(item.id);
  const span = `${hhmm(item.start)}–${hhmm(item.end)}`;
  bar.append(el_("span", span, "bar-time"));
  wireTip(bar, tipHTML(item));
  track.append(bar);
  row.append(track);
  return row;
}

// Build the (escaped) hover-tooltip markup for a schedule item: label, section,
// source phrase, and the start–end span. Joined to the activity client-side by id.
function tipHTML(item) {
  const a = activityFor(item.id);
  const label = (a && a.label) || item.id;
  const span = `${hhmm(item.start)} – ${hhmm(item.end)}`;
  let html = `<div class="tip-title">${escHTML(label)}</div>`;
  html += `<div class="tip-span">${escHTML(span)}</div>`;
  if (a && a.section) html += `<div class="tip-meta">${escHTML(a.section)}</div>`;
  if (a && a.resource) html += `<div class="tip-meta">Resource: ${escHTML(a.resource)}</div>`;
  if (a && a.source) html += `<div class="tip-src">“${escHTML(a.source)}”</div>`;
  return html;
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

  const header = document.createElement("div");
  header.className = "conflict-head";
  header.append(el_("span", "⚠", "conflict-icon"));
  header.append(el_("span", conflict.message || "These constraints clash.", "conflict-msg"));
  box.append(header);

  const kind = conflict.kind ? conflict.kind : "unknown";
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
