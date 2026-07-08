// The deep-read flow in the review modal: 🧠 button -> POST /deep_read -> proposal
// checkboxes -> only CHECKED items merge into the loaded plan (with ids filled).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const extractResult = {
  scenario: {
    activities: [{ id: "sweep", label: "Hazard Sweep", duration: 60, section: "shl" }],
    constraints: [],
    horizon: 2880,
  },
  coverage: { extraction: {} },
  warnings: [],
};

const deepResult = {
  document: "ops.docx",
  chunks: 2,
  calls: 2,
  errors: [],
  activities: [
    { id: "orbit_burn", label: "Orbit Burn", duration: 45, section: null,
      recurs_daily: false, source: "A 45-minute correction burn.", _guessed_duration: false },
  ],
  constraints: [
    { type: "precedence", before: "sweep", after: "orbit_burn", priority: 3,
      label: "orbit_burn after sweep (deep read)", source: "The burn follows the sweep.",
      rationale: "Proposed by the local model's deep read." },
  ],
  couldnt_model: [{ phrase: "runs once per operational cycle", reason: "no IR primitive yet" }],
};

test("deep read proposals render and only checked items load", async (t) => {
  const app = await loadApp({ responses: { "/extract": extractResult, "/deep_read": deepResult } });
  t.after(app.close);
  const { window, document } = app;

  await window.runExtract(new window.File(["fake"], "ops.docx"));
  await app.flush();

  // the deep-read button is offered, proposals not yet
  const btn = document.getElementById("deep-read-btn");
  assert.ok(btn, "deep read button rendered");
  btn.click();
  await app.flush(50);

  const call = app.calls.find((c) => c.url === "/deep_read");
  assert.ok(call, "POST /deep_read fired");
  assert.deepEqual(call.body.scenario.activities.map((a) => a.id), ["sweep"]);

  const box = document.getElementById("extract-deep");
  assert.match(box.textContent, /1 rule\(s\) and 1 new activity proposed/);
  assert.match(box.textContent, /The burn follows the sweep\./, "evidence quote shown");
  assert.match(box.textContent, /Couldn't model \(1\)/, "unmodelable statements listed");

  const checks = [...box.querySelectorAll("input[type=checkbox]")];
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.checked), "proposals default to checked");

  // reject the new activity, keep the rule — Load must respect the checkboxes
  const actBox = box.querySelector('input[data-kind="activity"]');
  actBox.checked = false;
  document.getElementById("extract-load").click();
  await app.flush(300);

  const acts = app.run("JSON.stringify(scenario.activities.map(a => a.id))");
  assert.equal(acts, JSON.stringify(["sweep"]), "unchecked activity NOT loaded");
  // the loaded plan may also carry the default day-hours rule from the load options —
  // the deep-read acceptance is the precedence rule
  const cons = JSON.parse(app.run("JSON.stringify(scenario.constraints)"));
  const prec = cons.filter((c) => c.type === "precedence");
  assert.equal(prec.length, 1);
  assert.equal(prec[0].after, "orbit_burn");
  assert.ok(prec[0].id, "review-added rule got an id at load");
  assert.equal(prec[0].enabled, true);
  const ids = cons.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "constraint ids are unique");

  assert.equal(app.errors.length, 0, `page errors: ${app.errors}`);
});
