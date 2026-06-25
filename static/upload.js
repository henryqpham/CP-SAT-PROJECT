// upload.js — the .docx import flow (Agent D's area).
//   /upload (fast in-memory scan) -> summary -> /extract (deterministic-first,
//   SSE-streamed) -> load scenario into the editor + render the coverage review.
//   initUpload() wires the file picker + Upload button, plus a drag-and-drop
//   dropzone and a small state machine (idle → uploading → extracting → built).

// 25 MB, mirrored from app.py's MAX_UPLOAD_BYTES so we can warn BEFORE a doomed
// upload round-trips and trips the server's 413 handler.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// ---- state machine ------------------------------------------------------
// One source of truth for "where in the flow are we", reflected as step chips
// and a status line. The Gantt/solve area owns everything after "built".
const UPLOAD_STEPS = [
  { key: "select", label: "Choose doc" },
  { key: "scan", label: "Scan" },
  { key: "extract", label: "Extract" },
  { key: "built", label: "Review" },
];
// idle → uploading → extracting → built (+ a transient error overlay).
let uploadState = "idle";
let pickedFile = null; // the File chosen via browse OR drop (the real <input> may not carry a dropped file).

function setUploadState(next) {
  uploadState = next;
  reflectUploadState();
}

// Map the abstract state to which step chip is active / done, and a status line.
function reflectUploadState() {
  const activeByState = { idle: -1, uploading: 1, extracting: 2, built: 3 };
  const active = activeByState[uploadState] ?? -1;
  const chips = $("upload-steps");
  if (chips) {
    [...chips.children].forEach((chip, i) => {
      chip.classList.toggle("step-active", i === active);
      chip.classList.toggle("step-done", i < active);
    });
  }
  const dz = $("dropzone");
  if (dz) dz.classList.toggle("dz-busy", uploadState === "uploading" || uploadState === "extracting");
}

function setStatusLine(text, tone) {
  const line = $("upload-status");
  if (!line) return;
  line.textContent = text || "";
  line.hidden = !text;
  line.className = "upload-status" + (tone ? " upload-status-" + tone : "");
}

// ---- init / wiring ------------------------------------------------------
function initUpload() {
  buildUploadChrome();

  const input = $("docx-file");
  input.addEventListener("change", () => {
    const f = input.files[0] || null;
    if (f) selectFile(f);
  });

  $("upload-btn").onclick = () => startUpload($("upload-btn"));
  reflectUploadState();
}

// Build the extra DOM this area owns (step chips, dropzone, status line) inside
// #upload-panel without touching index.html. Idempotent-ish: only builds once.
function buildUploadChrome() {
  const panel = $("upload-panel");
  if (!panel || $("upload-steps")) return;

  // Step chips: a crisp read on the current state.
  const steps = document.createElement("ol");
  steps.id = "upload-steps";
  steps.className = "upload-steps";
  steps.setAttribute("aria-label", "Import progress");
  UPLOAD_STEPS.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "step";
    li.append(el_("span", String(i + 1), "step-num"));
    li.append(el_("span", s.label, "step-lbl"));
    steps.append(li);
  });

  // Dropzone wraps the existing file input + Upload button row, so click-to-browse
  // keeps working and we add drag-and-drop on top.
  const row = panel.querySelector(".row");
  const dz = document.createElement("div");
  dz.id = "dropzone";
  dz.className = "dropzone";
  dz.setAttribute("role", "button");
  dz.setAttribute("tabindex", "0");
  dz.setAttribute("aria-label", "Drop a .docx requirements document here, or click to browse");

  const cue = document.createElement("div");
  cue.className = "dz-cue";
  cue.append(el_("span", "⬇", "dz-icon"));
  cue.append(el_("span", "Drag a .docx here", "dz-title"));
  cue.append(el_("span", "or click to browse", "dz-sub"));
  const name = el_("div", "", "dz-filename");
  name.id = "dz-filename";
  name.hidden = true;
  cue.append(name);
  dz.append(cue);

  // Insert: steps first, then the dropzone (which adopts the existing row).
  const lbl = panel.querySelector(".lbl");
  panel.insertBefore(steps, lbl ? lbl.nextSibling : panel.firstChild);
  if (row) {
    panel.insertBefore(dz, row);
    dz.append(row); // move the input+button row inside the dropzone
  } else {
    panel.insertBefore(dz, panel.firstChild);
  }

  // Status line lives just below the dropzone.
  const status = document.createElement("div");
  status.id = "upload-status";
  status.className = "upload-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  dz.after(status);

  wireDropzone(dz);
}

// Drag-and-drop + click-to-browse on the dropzone. A click anywhere that isn't an
// interactive control opens the native file picker; drops set the chosen file.
function wireDropzone(dz) {
  const input = $("docx-file");

  dz.addEventListener("click", (e) => {
    if (e.target.closest("button, input, a, select, label")) return; // let real controls work
    input.click();
  });
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((t) =>
    dz.addEventListener(t, (e) => {
      stop(e);
      dz.classList.add("dz-over");
    }),
  );
  ["dragleave", "dragend"].forEach((t) =>
    dz.addEventListener(t, (e) => {
      stop(e);
      dz.classList.remove("dz-over");
    }),
  );
  dz.addEventListener("drop", (e) => {
    stop(e);
    dz.classList.remove("dz-over");
    const dt = e.dataTransfer;
    const f = dt && dt.files && dt.files[0];
    if (!f) return;
    // Reflect the drop onto the real input too (so re-Upload via the button works),
    // guarded because assigning DataTransfer.files isn't universally supported.
    try {
      if (dt.files) input.files = dt.files;
    } catch {
      /* not assignable in this browser — we keep the File ourselves via pickedFile */
    }
    selectFile(f);
  });
}

// A file was chosen (browse or drop): validate extension + size client-side, show
// the name, and reset any prior result. The actual upload waits for the button.
function selectFile(file) {
  clearAlert();
  if (!file.name.toLowerCase().endsWith(".docx")) {
    setStatusLine(`“${file.name}” isn’t a .docx — choose a Word document.`, "bad");
    showAlert("Only .docx requirements documents are supported.");
    pickedFile = null;
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    setStatusLine(`“${file.name}” is ${mb} MB — over the 25 MB limit.`, "bad");
    showAlert(`That file is ${mb} MB; the limit is 25 MB. Trim or split the document and try again.`);
    pickedFile = null;
    return;
  }
  pickedFile = file;
  // Reset downstream state from any previous import.
  uploadBlocks = null;
  $("upload-summary").hidden = true;
  $("upload-summary").innerHTML = "";

  const name = $("dz-filename");
  if (name) {
    name.hidden = false;
    name.textContent = `${file.name} · ${prettyBytes(file.size)}`;
  }
  setStatusLine("Ready to scan — click Upload.", "info");
  setUploadState("idle");
}

function prettyBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- /upload (fast in-memory scan) --------------------------------------
function startUpload(btn) {
  const file = pickedFile || $("docx-file").files[0];
  if (!file) {
    setStatusLine("Choose a .docx file first.", "bad");
    showAlert("Choose a .docx file first — drag one in or click to browse.");
    return;
  }
  // Re-check size here too (drop path may have skipped the change handler).
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    showAlert(`That file is ${mb} MB; the limit is 25 MB.`);
    return;
  }

  setUploadState("uploading");
  setStatusLine("Scanning the document locally…", "info");

  // withBusy swallows the thrown error (it shows the alert + resolves), so we
  // can't rely on a .catch() to know it failed — track it with a flag instead,
  // and recover the state machine in the .then() that always runs.
  let ok = false;
  withBusy(btn, "Reading…", async () => {
    const form = new FormData();
    form.append("file", file);
    let r;
    try {
      r = await fetch("/upload", { method: "POST", body: form });
    } catch {
      throw new Error("Could not reach the server — is the Flask app running?");
    }
    const data = await safeJSON(r);
    if (!r.ok) {
      // 413 (oversize) and 400 (not a .docx / corrupt) both return {error}.
      const msg =
        r.status === 413
          ? "That file is over the 25 MB limit. Trim or split the document and try again."
          : (data && (data.message || data.error)) || `Upload failed (${r.status}).`;
      throw new Error(msg);
    }
    uploadBlocks = data.blocks || null;
    ok = true;
    renderUploadSummary(data.coverage || {});
    setStatusLine("Scan complete — review the counts, then build.", "ok");
    // Deterministic-first extraction is near-instant; flow straight on into it so
    // the whole import feels like one fast action.
    const build = $("build-btn");
    if (build) startExtract(build);
  }).then(() => {
    if (!ok) {
      // withBusy already surfaced the error via showAlert; reflect it in our line
      // and reset the state machine so the user can retry from idle.
      setUploadState("idle");
      setStatusLine("Upload failed — see the message above.", "bad");
    }
  });
}

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
  box.append(
    el_(
      "div",
      "Extraction runs deterministic-first on your machine — usually near-instant; " +
        "the local model only fills anything the rules can’t resolve.",
      "hint",
    ),
  );
}

// ---- /extract (deterministic-first, SSE-streamed) -----------------------
// Stream /extract via fetch + a reader (EventSource can't POST). Shows live
// per-chunk progress, then on `done` loads the scenario into the cards and
// renders the review panel.
function startExtract(btn) {
  if (!uploadBlocks) {
    setStatusLine("Upload a .docx first.", "bad");
    showAlert("Upload a .docx first.");
    return;
  }
  clearAlert();
  setUploadState("extracting");
  setStatusLine("Extracting constraints…", "info");

  const prog = $("extract-progress");
  prog.hidden = false;
  setProgress(0, 0, "Starting…");

  // Track terminal outcomes. `sawDone` lets us flag a stream that ends without a
  // terminal event; `sawError` records a terminal {type:"error"} (the fetch still
  // resolved 200, so withBusy never sees it). withBusy swallows a thrown error
  // (alert + resolve), so we use `ok` rather than a .catch() to recover state.
  let sawDone = false;
  let sawError = false;
  let ok = false;
  const onEvent = (ev) => {
    if (ev.type === "done") sawDone = true;
    if (ev.type === "error") sawError = true;
    onExtractEvent(ev);
  };

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
    await readSSE(resp.body, onEvent);
    if (sawError) return; // onExtractEvent already surfaced it + reset state
    if (!sawDone) {
      // The stream closed without a terminal done|error event.
      throw new Error("Extraction ended unexpectedly — no result was returned. Try Build again.");
    }
    ok = true;
  }).then(() => {
    if (ok) {
      // Hide the progress bar shortly after success so the snappy path doesn't
      // linger on a full bar; the user is already scrolling to the review panel.
      setTimeout(() => {
        prog.hidden = true;
      }, 350);
    } else {
      // A request-level throw (or the no-terminal-event case): withBusy surfaced
      // the alert; reflect + recover so the user can retry. (The terminal-error
      // case already reset state in onExtractEvent.)
      prog.hidden = true;
      if (!sawError) {
        setUploadState("idle");
        setStatusLine("Extraction failed — see the message above.", "bad");
      }
    }
  });
}

// One SSE event from /extract: progress (many) then a terminal done|error.
function onExtractEvent(ev) {
  if (ev.type === "progress") {
    setProgress(ev.i, ev.n, ev.label || "");
  } else if (ev.type === "error") {
    // Surface the terminal error; withBusy's wrapper won't see this (the fetch
    // resolved 200), so we must not let it pass silently.
    showAlert(ev.error || "Extraction failed.");
    setUploadState("idle");
    setStatusLine("Extraction failed — see the message above.", "bad");
  } else if (ev.type === "done") {
    setProgress(ev.coverage ? ev.coverage.n_extracted : 1, 1, "Done");
    // ---- HANDOFF (must stay intact): load the scenario into the editor and
    // render the coverage panel via Agent B's renderReview, then scroll there.
    scenario = ev.scenario || { activities: [], constraints: [] };
    collapsedSections.clear();
    render();
    renderReview(ev.coverage || {}, ev.warnings || []);
    setUploadState("built");
    const n = ev.coverage ? ev.coverage.n_extracted ?? 0 : 0;
    setStatusLine(`Built — ${n} item(s) extracted. Review coverage below, then Solve.`, "ok");
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
