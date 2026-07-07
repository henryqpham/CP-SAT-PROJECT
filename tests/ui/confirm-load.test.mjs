// Confirming the extract review loads the scenario into a NEW tab and re-solves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const extractResult = {
  scenario: {
    activities: [
      { id: "setup", label: "Setup", duration: 60, section: "Ops", type: "prep" },
      { id: "test_run", label: "Test run", duration: 120, section: "Ops", type: "ops" },
    ],
    constraints: [
      { id: "c1", type: "precedence", before: "setup", after: "test_run",
        priority: 2, enabled: true, source: "Setup must finish before the test run." },
    ],
    horizon: 2880,
  },
  coverage: { extraction: { by_method: { deterministic: 2 } } },
  warnings: [],
};

test("Load into new plan adds a tab, swaps the scenario, and fires a solve", async (t) => {
  const app = await loadApp({ responses: { "/extract": extractResult } });
  t.after(app.close);
  const { window, document } = app;

  // Get into the reviewed state via the real path.
  await window.runExtract(new window.File(["fake"], "mission.docx"));
  await app.flush();
  assert.equal(app.run("tabs.length"), 1, "one plan tab before confirming");
  assert.equal(app.calls.filter((c) => c.url === "/solve").length, 0, "no solve before confirming");

  // The load options are visible: horizon prefilled from the extraction (2880 -> 2 days)
  // and the day-hours rule offered (checked) for a non-schedule genre.
  assert.equal(document.getElementById("extract-horizon-days").value, "2");
  assert.equal(document.getElementById("extract-dayhours").checked, true);
  // shrink the plan window to 1 day before loading
  document.getElementById("extract-horizon-days").value = "1";

  // Click the modal's confirm button (wired to confirmExtractLoad).
  document.getElementById("extract-load").click();

  // A NEW tab holding the extracted scenario, now active + live.
  assert.equal(app.run("tabs.length"), 2);
  assert.equal(app.run("activeTab"), 1);
  assert.equal(app.run("tabs[1].name"), "Imported doc");
  // spread: page-realm arrays have a different Array prototype than Node's
  assert.deepEqual([...app.run("scenario.activities.map(a => a.id)")], ["setup", "test_run"]);
  // c1 from the doc + the day-hours rule added by the checked load option
  assert.deepEqual([...app.run("scenario.constraints.map(c => c.id)")], ["c1", "c2"]);
  const added = app.run("scenario.constraints[1]");
  assert.equal(added.type, "working_window");
  assert.equal(added.open, "08:00");
  assert.equal(added.priority, 3, "the added rule is soft — auto-relax may drop it");
  assert.equal(app.run("scenario.horizon"), 1440, "horizon follows the days input");
  assert.equal(document.getElementById("extract-modal").hidden, true, "modal closed");
  assert.equal(app.run("pendingExtract"), null, "pending extract cleared");

  // The load renders + auto-solves (250ms debounce) the new plan.
  await app.flush(300);
  const solves = app.calls.filter((c) => c.method === "POST" && c.url === "/solve");
  assert.equal(solves.length, 1, "one POST /solve after confirming");
  assert.deepEqual(solves[0].body.activities.map((a) => a.id), ["setup", "test_run"]);
  assert.equal(document.getElementById("status").textContent, "OPTIMAL");

  // The roster shows the new plan's activities.
  assert.ok(document.getElementById("roster").textContent.includes("Setup"));
  assert.equal(app.errors.length, 0, `page errors: ${app.errors}`);
});

// A "bad doc" (valid .docx, nothing schedulable) must NOT offer a loadable empty plan — it
// shows the verdict, hints the id-format fix, and disables Load.
const emptyExtract = {
  scenario: { activities: [], constraints: [], horizon: 7200 },
  coverage: {
    genre: "spec",
    near_miss_ids: { count: 40, example_found: "[SH 801]", example_fixed: "[SH-801]",
                     samples: ["[SH 801]", "[SH 802]"] },
    extraction: {},
  },
  warnings: ["Deterministic-first: 0/0 durations and 0/0 resources read by rules."],
};

test("A doc with nothing schedulable gates loading and hints the id fix", async (t) => {
  const app = await loadApp({ responses: { "/extract": emptyExtract } });
  t.after(app.close);
  const { window, document } = app;

  await window.runExtract(new window.File(["fake"], "logistics.docx"));
  await app.flush();

  // The review modal opens, but on the empty verdict — not a loadable plan.
  assert.equal(document.getElementById("extract-modal").hidden, false, "review modal open");
  const bodyText = document.getElementById("extract-body").textContent;
  assert.match(bodyText, /Nothing to schedule was found/i);
  // The near-miss hint names the exact fix: [SH 801] -> [SH-801].
  assert.match(bodyText, /\[SH 801\]/);
  assert.match(bodyText, /\[SH-801\]/);

  // The Load button is disabled and re-labelled — no blind confirm on nothing.
  const load = document.getElementById("extract-load");
  assert.equal(load.disabled, true, "load disabled when nothing extracted");
  assert.equal(load.textContent, "Nothing to load");

  // Even forcing the confirm path loads nothing: no new tab, no solve.
  const tabsBefore = app.run("tabs.length");
  app.run("confirmExtractLoad()");
  await app.flush(300);
  assert.equal(app.run("tabs.length"), tabsBefore, "no new tab from an empty import");
  assert.equal(app.calls.filter((c) => c.url === "/solve").length, 0, "no solve fired");
  assert.equal(app.errors.length, 0, `page errors: ${app.errors}`);
});
