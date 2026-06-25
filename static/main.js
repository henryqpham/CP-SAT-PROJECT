// main.js — top-level wiring, loaded LAST so every module's functions exist.
//   Bootstraps the editor/gantt/upload areas and wires the core flow buttons
//   (Parse, Load example, Solve). Per-area wiring lives in each module's initX().

loadExamples();
addConstraintType("sequence", "Sequence (ordered)");
initEditor();
initGantt();
initUpload();

$("parse-btn").onclick = () =>
  withBusy($("parse-btn"), "Parsing…", async () => {
    const sentence = $("sentence").value.trim();
    if (!sentence) return;
    scenario = await post("/parse", { sentence });
    render();
  });

$("example-select").onchange = async (e) => {
  const name = e.target.value;
  if (!name) return;
  clearAlert();
  try {
    scenario = await getJSON(`/example/${name}`);
    render();
  } catch (err) {
    showAlert(err.message);
  }
};

$("solve-btn").onclick = () =>
  withBusy($("solve-btn"), "Solving…", async () => {
    renderResult(await post("/solve", scenario));
  });

// Ctrl/Cmd+Enter parses from the textarea.
$("sentence").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("parse-btn").click();
});
