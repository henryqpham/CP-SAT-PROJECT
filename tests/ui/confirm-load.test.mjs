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

  // Click the modal's confirm button (wired to confirmExtractLoad).
  document.getElementById("extract-load").click();

  // A NEW tab holding the extracted scenario, now active + live.
  assert.equal(app.run("tabs.length"), 2);
  assert.equal(app.run("activeTab"), 1);
  assert.equal(app.run("tabs[1].name"), "Imported doc");
  // spread: page-realm arrays have a different Array prototype than Node's
  assert.deepEqual([...app.run("scenario.activities.map(a => a.id)")], ["setup", "test_run"]);
  assert.deepEqual([...app.run("scenario.constraints.map(c => c.id)")], ["c1"]);
  assert.equal(document.getElementById("extract-modal").hidden, true, "modal closed");
  assert.equal(app.run("pendingExtract"), null, "pending extract cleared");

  // The load renders + auto-solves (250ms debounce) the new plan.
  await app.flush(300);
  const solves = app.calls.filter((c) => c.method === "POST" && c.url === "/solve");
  assert.equal(solves.length, 1, "one POST /solve after confirming");
  assert.deepEqual(solves[0].body.activities.map((a) => a.id), ["setup", "test_run"]);
  assert.equal(solves[0].body.horizon, 2880, "multi-day horizon forwarded to the solver");
  assert.equal(document.getElementById("status").textContent, "OPTIMAL");

  // The roster shows the new plan's activities.
  assert.ok(document.getElementById("roster").textContent.includes("Setup"));
  assert.equal(app.errors.length, 0, `page errors: ${app.errors}`);
});
