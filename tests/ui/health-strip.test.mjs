// Health strip: the capacity gauge measures BOOKED WORK (sum of scheduled minutes),
// not the wall-clock span between first start and last end. Two parallel bars used
// to read as the longer bar's length; now they add up.
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

test("health strip measures booked work, not wall-clock span", async () => {
  const app = await loadApp({
    responses: {
      "/solve": {
        status: "OPTIMAL",
        // a and b run in PARALLEL: span = 90m, booked work = 150m.
        schedule: [
          { id: "a", start: 0, end: 60, source: "a" },
          { id: "b", start: 0, end: 90, source: "b" },
        ],
        horizon: 2880,
      },
    },
  });
  try {
    app.run(
      `scenario = { activities: [{ id: "a", duration: 60 }, { id: "b", duration: 90 }],
                    constraints: [], horizon: 2880 }; render();`
    );
    await app.flush(300); // let the debounced live solve settle

    const health = app.document.getElementById("health").textContent;
    assert.match(health, /work/, "gauge is labeled as work");
    // 150m of 2880m = 5%; the old span math would say 90m = 3%.
    assert.match(health, /\(5%\)/, "percent is booked-work based");
    assert.match(health, /45h 30m left|45h30m left/, "left = horizon minus booked work");
  } finally {
    app.close();
  }
});
