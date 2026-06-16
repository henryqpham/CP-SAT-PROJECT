// Dashboard: sentence -> /parse -> editable cards -> /solve -> Gantt.
let scenario = { activities: [], constraints: [] };

const $ = (id) => document.getElementById(id);

$("parse-btn").onclick = async () => {
  const sentence = $("sentence").value.trim();
  if (!sentence) return;
  scenario = await post("/parse", { sentence });
  render();
};

$("solve-btn").onclick = async () => {
  renderResult(await post("/solve", scenario));
};

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) console.warn(url, data);
  return data;
}

function render() {
  const box = $("constraints");
  box.innerHTML = "";

  // Activities: editable durations.
  for (const a of scenario.activities) {
    box.append(card(a.id, [numField("duration (min)", a.duration, (v) => (a.duration = v))], true));
  }

  // Constraints: enabled toggle + key editable fields.
  for (const c of scenario.constraints) {
    const fields = [];
    if (c.earliest != null) fields.push(textField("earliest", c.earliest, (v) => (c.earliest = v)));
    if (c.latest_end != null) fields.push(textField("latest_end", c.latest_end, (v) => (c.latest_end = v)));
    if (c.then && c.then.set_duration)
      fields.push(numField("factor", c.then.set_duration.factor, (v) => (c.then.set_duration.factor = v)));
    box.append(card(c.label || c.type, fields, c.enabled, (on) => (c.enabled = on), c.source));
  }
}

function card(title, fields, enabled, onToggle, source) {
  const el = document.createElement("div");
  el.className = "card" + (enabled ? "" : " off");
  const head = document.createElement("div");
  head.className = "card-head";
  if (onToggle) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = enabled;
    cb.onchange = () => {
      onToggle(cb.checked);
      el.classList.toggle("off", !cb.checked);
    };
    head.append(cb);
  }
  head.append(el_("strong", title));
  el.append(head);
  for (const f of fields) el.append(f);
  if (source) el.append(el_("small", "“" + source + "”"));
  return el;
}

function numField(label, value, onChange) {
  return field(label, value, "number", (v) => onChange(parseInt(v, 10)));
}
function textField(label, value, onChange) {
  return field(label, value, "text", onChange);
}
function field(label, value, type, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(document.createTextNode(label + " "));
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value;
  inp.oninput = () => onChange(inp.value);
  wrap.append(inp);
  return wrap;
}

function renderResult(result) {
  $("status").textContent = "Status: " + (result.status || "?");
  const tl = $("timeline");
  tl.innerHTML = "";
  if (!result.schedule) return;
  const DAY = 24 * 60;
  for (const item of result.schedule) {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.left = (100 * item.start) / DAY + "%";
    bar.style.width = (100 * (item.end - item.start)) / DAY + "%";
    bar.textContent = item.id;
    tl.append(bar);
  }
}

function el_(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}
