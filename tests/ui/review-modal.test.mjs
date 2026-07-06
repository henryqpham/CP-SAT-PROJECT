// The .docx import review modal: runExtract(file) -> POST /extract -> renderExtractReview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

// A small canned /extract answer (the fields renderExtractReview reads).
const extractResult = {
  scenario: {
    activities: [
      { id: "setup", label: "Setup", duration: 60, section: "Ops", type: "prep" },
      { id: "test_run", label: "Test run", duration: 120, section: "Ops", type: "ops" },
    ],
    constraints: [
      { id: "c1", type: "precedence", before: "setup", after: "test_run",
        priority: 2, enabled: true, source: "Setup must finish before the test run." },
      { id: "c2", type: "time_window", activity: "test_run", earliest: "09:00",
        latest_end: "17:00", day: 0, priority: 3, enabled: true, source: "Run during day 1 working hours." },
    ],
    horizon: 2880,
  },
  coverage: {
    extraction: { by_method: { deterministic: 2 }, dependencies: { deterministic: 1 }, dated_deadlines: 1 },
    not_extracted: ["REQ-7 crew rest period"],
    dangling_references: [],
    start_date: "2026-07-01",
    horizon_days: 2,
  },
  warnings: ["Duration for 'setup' taken from the summary table."],
};

test("review modal lists the extracted activities, constraints, flags and notes", async (t) => {
  const app = await loadApp({ responses: { "/extract": extractResult } });
  t.after(app.close);
  const { window, document } = app;

  // Follow the real code path: runExtract posts the file, stores pendingExtract, opens the modal.
  const file = new window.File(["fake docx bytes"], "mission.docx");
  await window.runExtract(file);
  await app.flush();

  const post = app.calls.find((c) => c.method === "POST" && c.url === "/extract");
  assert.ok(post, "runExtract should POST /extract");
  assert.equal(post.body.get("document").name, "mission.docx");

  assert.equal(document.getElementById("extract-modal").hidden, false, "modal is open");
  assert.equal(app.run("pendingExtract"), extractResult, "pendingExtract holds the server answer");

  const body = document.getElementById("extract-body");

  // Summary chips: activity + constraint counts.
  const chips = [...body.querySelectorAll(".extract-chip")].map((c) =>
    c.querySelector(".extract-chip-val").textContent + " " + c.querySelector(".extract-chip-lbl").textContent);
  assert.ok(chips.includes("2 activities"), `chips: ${chips}`);
  assert.ok(chips.includes("2 constraints"), `chips: ${chips}`);

  // Section titles carry the counts too.
  const titles = [...body.querySelectorAll(".extract-section-title")].map((h) => h.textContent);
  assert.deepEqual(titles, ["Activities (2)", "Constraints (2)"]);

  // One table row per activity / constraint, with the right content.
  const [actTable, conTable] = body.querySelectorAll(".extract-table");
  const actRows = [...actTable.querySelectorAll("tbody tr")];
  assert.equal(actRows.length, 2);
  assert.equal(actRows[0].cells[0].textContent, "setup");
  assert.equal(actRows[1].cells[0].textContent, "test_run");
  const conRows = [...conTable.querySelectorAll("tbody tr")];
  assert.equal(conRows.length, 2);
  assert.ok(conRows[0].textContent.includes("setup → test_run"));
  assert.ok(conRows[1].textContent.includes("test_run"));

  // Coverage flag for the not-extracted requirement.
  const flags = [...body.querySelectorAll(".extract-flag")].map((f) => f.textContent);
  assert.equal(flags.length, 1);
  assert.ok(flags[0].includes("NOT extracted"));
  assert.ok(flags[0].includes("REQ-7 crew rest period"));

  // The warning shows up as an extraction note.
  const notes = [...body.querySelectorAll(".extract-notes-list li")].map((li) => li.textContent);
  assert.deepEqual(notes, ["Duration for 'setup' taken from the summary table."]);

  assert.equal(app.errors.length, 0, `page errors: ${app.errors}`);
});
