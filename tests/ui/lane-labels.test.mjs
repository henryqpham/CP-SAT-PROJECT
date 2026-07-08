// Timeline lanes show the glossary label from scenario.section_labels (doc-imported
// plans name owners by acronym); the raw section id stays in the hover title.
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

test("section lane shows the glossary label, hover keeps the raw id", async () => {
  const app = await loadApp();
  try {
    app.run(
      `scenario = { activities: [{ id: "a", duration: 60, section: "srme" }],
                    constraints: [],
                    section_labels: { srme: "Synthetic Resource Modeling Engine" } };
       render();`
    );
    await app.flush(300); // let the debounced live solve settle

    const names = [...app.document.querySelectorAll(".sec-name")];
    const lane = names.find((n) => n.textContent.includes("Synthetic Resource Modeling Engine"));
    assert.ok(lane, "lane label uses the glossary long form");
    assert.equal(lane.title, "srme", "raw section id kept on hover");
  } finally {
    app.close();
  }
});
