// Fill window + the two chat panels (Ask the doc, Plan assistant), on mocked endpoints.
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const PLAN = {
  activities: [
    { id: "a", duration: 60, section: "ops" },
    { id: "b", duration: 50, section: "ops" },
  ],
  constraints: [],
};

test("fill window POSTs /fill and shows per-section utilization", async () => {
  const app = await loadApp({
    responses: {
      "/fill": {
        status: "OPTIMAL",
        schedule: [{ id: "a", start: 0, end: 60, source: "a" }],
        horizon: 100,
        left_out: ["b"],
        fill: {
          overall: { capacity: 100, used: 60, pct: 60, left: 40, overflow: 50 },
          sections: { ops: { capacity: 100, used: 60, pct: 60, left: 40 } },
        },
      },
    },
  });
  try {
    app.run(`scenario = ${JSON.stringify(PLAN)}; render();`);
    await app.flush(300); // let the debounced live solve settle first

    app.document.getElementById("fill-btn").click();
    await app.flush(50);

    assert.ok(app.calls.some((c) => c.url === "/fill"), "POST /fill fired");
    const health = app.document.getElementById("health").textContent;
    assert.match(health, /FILL/);
    assert.match(health, /ops 60% · 40m left/);
    assert.match(health, /didn't fit/);
    // the left-out list lands in the toast
    assert.match(app.document.getElementById("toast").textContent, /left out: b/);
  } finally {
    app.close();
  }
});

test("ask-the-doc renders the answer with its cited sources", async () => {
  const app = await loadApp({
    responses: {
      "/doc_chat": {
        answer: "Sleep is 8h15m [2].",
        sources: [
          { n: 1, block: 3, section: "Day 1", text: "Sleep" },
          { n: 2, block: 9, section: "Global Constraints", text: "Sleep: 8h15m contiguous" },
        ],
        document: "artemis.docx",
      },
    },
  });
  try {
    app.document.getElementById("doc-chat-open").click();
    const input = app.document.getElementById("doc-chat-input");
    input.value = "how long is sleep?";
    app.document.getElementById("doc-chat-send").click();
    await app.flush(30);

    const log = app.document.getElementById("doc-chat-log");
    assert.match(log.querySelector(".chat-user").textContent, /how long is sleep/);
    // the first bot bubble is the seeded intro (capability line + example prompts);
    // the ANSWER is the last one
    const bots = [...log.querySelectorAll(".chat-bot")];
    assert.match(bots[0].textContent, /I answer questions about the last imported document/);
    const bot = bots[bots.length - 1];
    assert.match(bot.textContent, /8h15m \[2\]/);
    assert.match(bot.querySelector(".chat-sources").textContent, /Global Constraints — Sleep: 8h15m/);
    assert.match(bot.querySelector("summary").textContent, /Sources \(2\)/);
    assert.match(app.document.getElementById("doc-chat-name").textContent, /artemis\.docx/);
  } finally {
    app.close();
  }
});

test("assistant edit applies through the normal path and is undoable", async () => {
  const changed = {
    activities: [...PLAN.activities, { id: "swim", duration: 45, section: "ops" }],
    constraints: [],
  };
  const app = await loadApp({
    responses: {
      "/assist": {
        reply: "Added a swim.",
        changed: true,
        scenario: changed,
        actions: ["added activity swim (45m, section ops)"],
      },
    },
  });
  try {
    app.run(`scenario = ${JSON.stringify(PLAN)}; render();`);
    await app.flush(500); // settle solve + history debounces

    app.document.getElementById("assistant-open").click();
    app.document.getElementById("assistant-input").value = "add a 45m swim";
    app.document.getElementById("assistant-send").click();
    await app.flush(500);

    assert.ok(app.calls.some((c) => c.url === "/assist"), "POST /assist fired");
    assert.equal(app.run("scenario.activities.length"), 3);
    const log = app.document.getElementById("assistant-log");
    assert.match(log.querySelector(".chat-actions").textContent, /added activity swim/);
    // a live re-solve followed the apply
    assert.ok(app.calls.filter((c) => c.url === "/solve").length >= 2, "re-solve fired");

    app.run("undo()");
    await app.flush(50);
    assert.equal(app.run("scenario.activities.length"), 2, "undo removed the assistant edit");
  } finally {
    app.close();
  }
});
