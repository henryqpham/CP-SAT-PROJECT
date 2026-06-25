// coverage.js — the coverage / review panel (Agent B's area).
//   The TRUST CENTERPIECE. The story: the local model is SUPERVISED, not trusted.
//   Extraction of a 15-page requirements .docx is deterministic-FIRST; this panel
//   PROVES nothing was dropped and shows HOW each requirement was resolved
//   (deterministic / llm / default). Renders from the /extract `coverage` report.
//   See extract.py `_reconcile` + `_extraction_report` for the exact shape:
//     coverage = { requirement_ids_in_doc[], n_in_doc, n_extracted, not_extracted[],
//       defaulted_duration[], dangling_references[{constraint, missing}],
//       n_activities, n_constraints,
//       extraction: { by_method{deterministic,llm,default}, duration{…}, resource{…},
//         dependencies{deterministic,llm}, dated_deadlines, residual_requirements[],
//         llm_calls, cross_references{ narrative[], ambiguous[] } } }
//   Note: duration/resource arrays hold RAW req ids ("VR-110"); the matching activity
//   card id is rawToId(raw) = raw.toLowerCase().replace(/-/g,'_'). focusCard(id) jumps
//   to either an activity card (data-aid) or a constraint card (data-cid).

// A raw requirement id ("VR-512") -> its normalized activity-card id ("vr_512").
function rawToId(raw) {
  return String(raw).toLowerCase().replace(/-/g, "_");
}

// The MANDATORY review panel: account for every requirement, and show — per item —
// HOW it was resolved, so a reviewer can trust the deterministic-first pipeline.
function renderReview(coverage, warnings) {
  const panel = $("review");
  const box = $("review-body");
  panel.hidden = false;
  box.innerHTML = "";

  coverage = coverage || {};
  warnings = warnings || [];
  const ex = coverage.extraction || {};

  const notExtracted = coverage.not_extracted || [];
  const defaulted = coverage.defaulted_duration || [];
  const dangling = coverage.dangling_references || [];

  const nDoc = coverage.n_in_doc ?? (coverage.requirement_ids_in_doc || []).length;
  const nExtracted = coverage.n_extracted ?? 0;
  const fullCoverage = notExtracted.length === 0;
  const llmCalls = ex.llm_calls ?? 0;

  // ---- 1. HERO: the unmissable headline — "29/29 requirements · 0 dropped". -------
  box.append(reviewHero(nDoc, nExtracted, notExtracted.length, fullCoverage, llmCalls));

  // The framing line: this is a draft to VERIFY against each item's source.
  box.append(el_("p",
    "Read deterministically from your document — rules first, the local model only for what " +
    "rules can't resolve. Verify each item against its source (shown on every activity card " +
    "below) before solving.", "review-note"));

  // ---- A compact stat strip (doc-level counts). ----------------------------------
  const stats = el_("div", "", "stat-row");
  stats.append(stat(nDoc, "in document"));
  stats.append(stat(nExtracted, "extracted"));
  stats.append(stat(coverage.n_activities ?? 0, "activities"));
  stats.append(stat(coverage.n_constraints ?? 0, "constraints"));
  box.append(stats);

  // ---- 2. METHOD BREAKDOWN: the reliability story, sold visually. ----------------
  box.append(methodBreakdown(ex));

  // ---- 3. DEPENDENCY EDGES: count + clickable list, 100% deterministic. ----------
  box.append(dependencySection(ex));

  // ---- Dated deadlines (deterministic) — a small supporting note. ----------------
  const nDeadlines = ex.dated_deadlines ?? 0;
  if (nDeadlines) {
    const dl = el_("div", "", "cov-line");
    dl.append(badgeMethod("deterministic"));
    dl.append(el_("span",
      `${nDeadlines} dated deadline${nDeadlines === 1 ? "" : "s"} resolved from the document`,
      "cov-line-text"));
    box.append(dl);
  }

  // ---- 4. CROSS-REFERENCE AUDIT: refs the rules deliberately did NOT make edges. --
  box.append(crossRefAudit(ex.cross_references || {}));

  // ---- 5. FLAGGED / DROPPED items (red/amber). -----------------------------------
  if (notExtracted.length) {
    box.append(reviewFlag("bad",
      `${notExtracted.length} requirement${notExtracted.length === 1 ? " was" : "s were"} ` +
      `in the document but NOT extracted`,
      notExtracted, (raw) => focusCard(rawToId(raw))));
  }
  if (defaulted.length) {
    box.append(reviewFlag("warn",
      `${defaulted.length} activit${defaulted.length === 1 ? "y" : "ies"} had no stated ` +
      `duration — duration guessed, verify against the source`,
      defaulted, (raw) => focusCard(rawToId(raw))));
  }
  if (dangling.length) {
    box.append(reviewFlag("bad",
      `${dangling.length} constraint reference${dangling.length === 1 ? "" : "s"} ` +
      `point at a missing activity`,
      dangling.map((d) => `${d.constraint} → ${d.missing}`),
      null, dangling.map((d) => d.constraint)));
  }

  // ---- 6. PER-REQUIREMENT method tags: how each item's duration/resource resolved. -
  box.append(perRequirementTable(coverage, ex));

  // ---- 7. Residual / LLM-call count + the extraction summary warnings. ------------
  box.append(residualSection(ex));
  if (warnings.length) {
    const wrap = el_("div", "", "review-flag review-warn");
    wrap.append(el_("div", "Notes from extraction", "review-flag-title"));
    const ul = el_("ul", "", "review-pills review-notes");
    for (const w of warnings) ul.append(el_("li", w, "review-note-item"));
    wrap.append(ul);
    box.append(wrap);
  }
}

// ---- HERO -----------------------------------------------------------------------
// Big, scannable headline. Green when nothing dropped, red if anything is.
function reviewHero(nDoc, nExtracted, nDropped, fullCoverage, llmCalls) {
  const hero = el_("div", "", "cov-hero " + (fullCoverage ? "cov-hero-ok" : "cov-hero-bad"));

  const left = el_("div", "", "cov-hero-main");
  const big = el_("div", "", "cov-hero-num");
  big.append(el_("span", String(nExtracted), "cov-hero-n"));
  big.append(el_("span", "/", "cov-hero-slash"));
  big.append(el_("span", String(nDoc), "cov-hero-d"));
  big.append(el_("span", "requirements", "cov-hero-unit"));
  left.append(big);

  const sub = el_("div", "", "cov-hero-sub");
  if (fullCoverage) {
    sub.append(el_("span", "✓", "cov-hero-check"));
    sub.append(el_("span", "0 dropped — every requirement in the document was accounted for",
      "cov-hero-sub-text"));
  } else {
    sub.append(el_("span", "✕", "cov-hero-check"));
    sub.append(el_("span",
      `${nDropped} requirement${nDropped === 1 ? "" : "s"} dropped — see flagged items below`,
      "cov-hero-sub-text"));
  }
  left.append(sub);
  hero.append(left);

  // The LLM-call hero badge: "Fully deterministic — 0 model calls" is the punchline.
  const badge = el_("div", "",
    "cov-hero-badge " + (llmCalls === 0 ? "cov-hero-badge-det" : "cov-hero-badge-llm"));
  if (llmCalls === 0) {
    badge.append(el_("span", "Fully deterministic", "cov-hero-badge-top"));
    badge.append(el_("span", "0 model calls", "cov-hero-badge-bot"));
  } else {
    badge.append(el_("span", `${llmCalls} model call${llmCalls === 1 ? "" : "s"}`,
      "cov-hero-badge-top"));
    badge.append(el_("span", "residual only", "cov-hero-badge-bot"));
  }
  hero.append(badge);
  return hero;
}

// ---- METHOD BREAKDOWN -----------------------------------------------------------
// Two segmented bars (durations + resources) + a shared legend. "Read by rules"
// (deterministic) is visually dominant via the .tag-deterministic palette.
function methodBreakdown(ex) {
  const wrap = el_("div", "", "cov-section");
  wrap.append(el_("h3", "How each field was resolved", "cov-h3"));
  wrap.append(el_("p",
    "Durations and resources, by method. Rules read everything they reliably can; " +
    "the model fills only the residual.", "cov-sub"));

  // Duration headline uses by_method (counts); fall back to the duration arrays.
  const dur = ex.duration || {};
  const byMethod = ex.by_method || {};
  const durSegs = [
    { method: "deterministic", label: "rules", n: byMethod.deterministic ?? (dur.deterministic || []).length },
    { method: "llm", label: "model", n: byMethod.llm ?? (dur.llm || []).length },
    { method: "default", label: "guessed", n: byMethod.default ?? (dur.default || []).length },
  ];
  wrap.append(segBar("Durations", durSegs));

  const res = ex.resource || {};
  const resSegs = [
    { method: "deterministic", label: "rules", n: (res.deterministic || []).length },
    { method: "llm", label: "model", n: (res.llm || []).length },
    { method: "none", label: "unset", n: (res.none || []).length },
  ];
  wrap.append(segBar("Resources", resSegs));

  // Shared legend (the .tag-* palette).
  const legend = el_("div", "", "cov-legend");
  legend.append(legendItem("deterministic", "read by rules"));
  legend.append(legendItem("llm", "filled by local model"));
  legend.append(legendItem("default", "guessed / unset"));
  wrap.append(legend);
  return wrap;
}

// A labeled segmented bar. Segments scale by count; empty segments are omitted.
function segBar(title, segs) {
  const total = segs.reduce((s, x) => s + (x.n || 0), 0);
  const row = el_("div", "", "cov-bar-row");

  const head = el_("div", "", "cov-bar-head");
  head.append(el_("span", title, "cov-bar-title"));
  const detN = (segs.find((s) => s.method === "deterministic") || {}).n || 0;
  head.append(el_("span", total ? `${detN}/${total} by rules` : "—", "cov-bar-count"));
  row.append(head);

  const bar = el_("div", "", "cov-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label",
    `${title}: ` + segs.filter((s) => s.n).map((s) => `${s.n} ${s.label}`).join(", "));
  if (total === 0) {
    bar.append(el_("span", "", "cov-bar-seg cov-bar-empty"));
  } else {
    for (const s of segs) {
      if (!s.n) continue;
      const seg = el_("span", "", "cov-bar-seg seg-" + s.method);
      seg.style.flexGrow = String(s.n);
      seg.title = `${s.n} ${s.label}`;
      if (s.n / total > 0.12) seg.textContent = String(s.n); // label only if it fits
      bar.append(seg);
    }
  }
  row.append(bar);
  return row;
}

function legendItem(method, text) {
  const item = el_("span", "", "cov-legend-item");
  const sw = el_("span", "", "cov-legend-sw seg-" + method);
  item.append(sw);
  item.append(el_("span", text, "cov-legend-text"));
  return item;
}

// ---- DEPENDENCY EDGES -----------------------------------------------------------
// The precedence constraints on the live scenario — 100% deterministic and
// authoritative. Each row clicks through to its constraint card.
function dependencySection(ex) {
  const wrap = el_("div", "", "cov-section");
  const deps = ex.dependencies || {};
  const edges = (scenario.constraints || []).filter((c) => c.type === "precedence");

  const head = el_("div", "", "cov-section-head");
  head.append(el_("h3", "Dependency edges", "cov-h3"));
  head.append(badgeMethod("deterministic"));
  const detCount = deps.deterministic ?? edges.length;
  head.append(el_("span", `${detCount} edge${detCount === 1 ? "" : "s"} · 0 from the model`,
    "cov-section-count"));
  wrap.append(head);
  wrap.append(el_("p",
    "Every precedence edge comes from a rule reading the document. The model never " +
    "creates an edge — so a narrative mention can't become a false prerequisite.", "cov-sub"));

  if (!edges.length) {
    wrap.append(el_("div", "No dependency edges were found in the document.", "cov-empty"));
    return wrap;
  }

  const list = el_("ul", "", "cov-edges");
  for (const e of edges) {
    const li = el_("li", "", "cov-edge");
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    const title = e.label || `${e.before} → ${e.after}`;
    li.title = (e.source ? `“${e.source}”` : title) + "  (click to jump to its card)";

    const flow = el_("span", "", "cov-edge-flow");
    flow.append(el_("code", e.before, "cov-edge-node"));
    flow.append(el_("span", "→", "cov-edge-arrow"));
    flow.append(el_("code", e.after, "cov-edge-node"));
    li.append(flow);
    if (e.source) li.append(el_("span", e.source, "cov-edge-src"));

    const go = () => focusCard(e.id);
    li.onclick = go;
    li.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } };
    list.append(li);
  }
  wrap.append(list);
  return wrap;
}

// ---- CROSS-REFERENCE AUDIT ------------------------------------------------------
// The clever part: cross-references the rules deliberately did NOT turn into edges,
// surfaced for HUMAN review. Narrative (guarded) + ambiguous (off-format).
function crossRefAudit(xref) {
  const wrap = el_("div", "", "cov-section");
  const narrative = xref.narrative || [];
  const ambiguous = xref.ambiguous || [];

  const head = el_("div", "", "cov-section-head");
  head.append(el_("h3", "Cross-reference audit", "cov-h3"));
  head.append(el_("span", "surfaced for human review — never auto-added", "cov-audit-tag"));
  wrap.append(head);
  wrap.append(el_("p",
    "References the rules saw but deliberately did NOT turn into a dependency. " +
    "They are shown here so a human can decide — the pipeline never adds them silently.",
    "cov-sub"));

  if (!narrative.length && !ambiguous.length) {
    wrap.append(el_("div",
      "None — every cross-reference in the document was a clean, in-format dependency.",
      "cov-empty cov-empty-ok"));
    return wrap;
  }

  if (narrative.length) {
    wrap.append(xrefGroup("Narrative mentions",
      "Phrased as narration (e.g. “after VR-200 is photographed”), not a prerequisite — guarded out.",
      narrative, "xref-narrative"));
  }
  if (ambiguous.length) {
    wrap.append(xrefGroup("Off-format references",
      "Genuinely ambiguous references the rules can't safely interpret — needs a human call.",
      ambiguous, "xref-ambiguous"));
  }
  return wrap;
}

function xrefGroup(title, blurb, items, cls) {
  const grp = el_("div", "", "cov-xref-group " + cls);
  grp.append(el_("div", `${title} (${items.length})`, "cov-xref-title"));
  grp.append(el_("div", blurb, "cov-xref-blurb"));
  const ul = el_("ul", "", "cov-xref-list");
  for (const x of items) {
    const li = el_("li", "", "cov-xref-item");
    const refs = Array.isArray(x.references) ? x.references : [x.references];
    const flow = el_("span", "", "cov-xref-flow");
    // The requirement (clickable -> its activity card) references one or more targets.
    flow.append(reqPill(x.requirement));
    flow.append(el_("span", "refers to", "cov-xref-verb"));
    for (const r of refs) flow.append(reqPill(r));
    li.append(flow);
    if (x.phrase) li.append(el_("span", `“${x.phrase}”`, "cov-xref-phrase"));
    ul.append(li);
  }
  grp.append(ul);
  return grp;
}

// A small clickable requirement chip -> focusCard(its activity card).
function reqPill(raw) {
  const pill = el_("button", raw, "cov-req-pill");
  pill.type = "button";
  pill.title = `Jump to ${raw}`;
  pill.onclick = () => focusCard(rawToId(raw));
  return pill;
}

// ---- PER-REQUIREMENT method table -----------------------------------------------
// For each requirement: a clickable id + a duration tag + a resource tag, so a
// reviewer sees AT A GLANCE how every item was resolved.
function perRequirementTable(coverage, ex) {
  const wrap = el_("div", "", "cov-section");
  const head = el_("div", "", "cov-section-head");
  head.append(el_("h3", "Per-requirement resolution", "cov-h3"));
  wrap.append(head);
  wrap.append(el_("p",
    "How each requirement's duration and resource were resolved. Click an id to jump to " +
    "its activity card and check it against the source.", "cov-sub"));

  // Build raw-id -> method lookups from the duration/resource arrays.
  const durMethod = methodLookup(ex.duration || {});
  const resMethod = methodLookup(ex.resource || {});
  const ids = (coverage.requirement_ids_in_doc || []).slice().sort(cmpReqId);
  const notExtracted = new Set(coverage.not_extracted || []);

  if (!ids.length) {
    wrap.append(el_("div", "No requirement ids were found in the document.", "cov-empty"));
    return wrap;
  }

  // A compact legend header row.
  const grid = el_("div", "", "cov-grid");
  const hdr = el_("div", "", "cov-grid-row cov-grid-head");
  hdr.append(el_("span", "requirement", "cov-grid-id"));
  hdr.append(el_("span", "duration", "cov-grid-cell"));
  hdr.append(el_("span", "resource", "cov-grid-cell"));
  grid.append(hdr);

  for (const raw of ids) {
    const row = el_("div", "", "cov-grid-row");
    const dropped = notExtracted.has(raw);

    const idBtn = el_("button", raw, "cov-grid-id" + (dropped ? " cov-grid-dropped" : ""));
    idBtn.type = "button";
    idBtn.title = dropped ? `${raw} was NOT extracted` : `Jump to ${raw}`;
    idBtn.onclick = () => focusCard(rawToId(raw));
    row.append(idBtn);

    if (dropped) {
      const cell = el_("span", "", "cov-grid-cell");
      cell.append(dropTag());
      row.append(cell);
      row.append(el_("span", "", "cov-grid-cell"));
    } else {
      row.append(methodCell(durMethod[raw] || "default"));
      row.append(methodCell(resMethod[raw] || "none"));
    }
    grid.append(row);
  }
  wrap.append(grid);
  return wrap;
}

// raw id -> "deterministic" | "llm" | "default" | "none" from a {method: [ids]} map.
function methodLookup(byMethod) {
  const out = {};
  for (const method of Object.keys(byMethod)) {
    for (const raw of byMethod[method] || []) out[raw] = method;
  }
  return out;
}

function methodCell(method) {
  const cell = el_("span", "", "cov-grid-cell");
  cell.append(badgeMethod(method));
  return cell;
}

function dropTag() {
  return el_("span", "dropped", "tag tag-none cov-drop-tag");
}

// A method tag using the shared .tag-* palette. "none" reuses .tag-none.
function badgeMethod(method) {
  const text = {
    deterministic: "rules",
    llm: "model",
    default: "guessed",
    none: "unset",
  }[method] || method;
  const tag = el_("span", text, "tag tag-" + method);
  tag.title = {
    deterministic: "read deterministically by a rule",
    llm: "filled by the local model (residual)",
    default: "no stated value — guessed",
    none: "no resource stated",
  }[method] || method;
  return tag;
}

// ---- RESIDUAL / LLM calls -------------------------------------------------------
function residualSection(ex) {
  const residual = ex.residual_requirements || [];
  const llmCalls = ex.llm_calls ?? 0;
  const level = llmCalls === 0 ? "ok" : "warn";
  const wrap = el_("div", "", "review-flag review-" + level);

  const title = llmCalls === 0
    ? "No residual — the local model was not called"
    : `${residual.length} residual requirement${residual.length === 1 ? "" : "s"} ` +
      `sent to the local model in ${llmCalls} call${llmCalls === 1 ? "" : "s"}`;
  wrap.append(el_("div", title, "review-flag-title"));
  wrap.append(el_("div",
    llmCalls === 0
      ? "Rules resolved every field, so nothing left the deterministic path."
      : "Only fields the rules left open (no stated duration/resource) were sent — the model " +
        "can never create or drop a dependency.",
    "cov-sub"));
  if (residual.length) {
    const ul = el_("ul", "", "review-pills");
    for (const raw of residual) {
      const li = el_("li", "", "cov-clickable");
      li.textContent = raw;
      li.title = `Jump to ${raw}`;
      li.onclick = () => focusCard(rawToId(raw));
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

// ---- shared flag block (kept for not_extracted / defaulted / dangling) ----------
// A colored review block: title + a list of pills. Optional onClick(item) makes
// each pill clickable; clickIds[i] (if given) is the focus target for pill i.
function reviewFlag(level, title, items, onClick, clickIds) {
  const wrap = el_("div", "", "review-flag review-" + level);
  wrap.append(el_("div", title, "review-flag-title"));
  if (items && items.length) {
    const ul = el_("ul", "", "review-pills");
    items.forEach((it, i) => {
      const li = el_("li", String(it), "");
      const target = clickIds ? clickIds[i] : it;
      if (onClick || clickIds) {
        li.className = "cov-clickable";
        li.title = "Jump to its card";
        li.onclick = () => (onClick ? onClick(target) : focusCard(target));
      }
      ul.append(li);
    });
    wrap.append(ul);
  }
  return wrap;
}

// Stable requirement-id ordering: by numeric suffix (VR-110 before VR-1010).
function cmpReqId(a, b) {
  const na = parseInt(String(a).replace(/\D+/g, ""), 10);
  const nb = parseInt(String(b).replace(/\D+/g, ""), 10);
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
  return na - nb;
}
