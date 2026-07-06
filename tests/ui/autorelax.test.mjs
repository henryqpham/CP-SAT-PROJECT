// INFEASIBLE banner -> "Auto-relax lowest priority" -> POST /relax -> the dropped rule is
// disabled + marked RELAXED and the plan re-solves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const scenario = {
  activities: [
    { id: "a", duration: 60, section: "Ops" },
    { id: "b", duration: 60, section: "Ops" },
  ],
  constraints: [
    { id: "c1", type: "precedence", before: "a", after: "b", enabled: true, priority: 1, label: "a before b" },
    { id: "c2", type: "time_window", activity: "b", latest_end: "01:00", enabled: true, priority: 5, label: "b by 1am" },
  ],
};

// INFEASIBLE while c2 is enabled; OPTIMAL once auto-relax has turned it off.
const solveMock = (body) => {
  const c2 = (body.constraints || []).find((c) => c.id === "c2");
  if (c2 && c2.enabled !== false) return { status: "INFEASIBLE" };
  return {
    status: "OPTIMAL",
    horizon: 1440,
    schedule: [{ id: "a", start: 0, end: 60 }, { id: "b", start: 60, end: 120 }],
  };
};

test("auto-relax disables the dropped rule, marks it relaxed, and re-solves", async (t) => {
  const app = await loadApp({
    responses: {
      "/solve": solveMock,
      "/relax": { solved: true, dropped: ["c2"], structural: false, hard_conflict: [] },
    },
  });
  t.after(app.close);
  const { document } = app;

  // Load the plan through the app's own path: swap the live scenario, then render (auto-solves).
  app.run(`scenario = ${JSON.stringify(scenario)}; render();`);
  await app.flush(300); // past the 250ms solve debounce

  // The INFEASIBLE banner is up, with the auto-relax button.
  assert.equal(document.getElementById("status").textContent, "INFEASIBLE");
  const banner = document.getElementById("banner");
  assert.equal(banner.hidden, false);
  const relaxBtn = [...banner.querySelectorAll("button")].find((b) => b.textContent.includes("Auto-relax"));
  assert.ok(relaxBtn, "banner has an Auto-relax button");

  relaxBtn.click();
  await app.flush(300); // /relax reply + the re-solve debounce

  // c2 is now off and marked relaxed; c1 untouched.
  assert.equal(app.run("scenario.constraints.find(c => c.id === 'c2').enabled"), false);
  assert.equal(app.run("scenario.constraints.find(c => c.id === 'c1').enabled"), true);
  assert.equal(app.run("relaxedIds.has('c2')"), true, "c2 marked RELAXED in the constraints state");

  // A /relax call, then a re-solve carrying the disabled c2 — which came back OPTIMAL.
  assert.equal(app.calls.filter((c) => c.url === "/relax").length, 1);
  const solves = app.calls.filter((c) => c.method === "POST" && c.url === "/solve");
  assert.equal(solves.length, 2, "initial solve + the post-relax re-solve");
  assert.equal(solves[1].body.constraints.find((c) => c.id === "c2").enabled, false);
  assert.equal(document.getElementById("status").textContent, "OPTIMAL");
  assert.equal(banner.hidden, true, "banner cleared by the feasible re-solve");
  assert.ok(document.getElementById("toast").textContent.includes("Relaxed 1 rule"));

  assert.equal(app.errors.length, 0, `page errors: ${app.errors}`);
});
