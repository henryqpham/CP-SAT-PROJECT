// jsdom harness for the dashboard: loads templates/index.html + static/app.js in a fake
// browser with a mocked fetch, so the UI flows can be tested without Flask running.
import { JSDOM, VirtualConsole } from "jsdom";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root (this file lives in tests/ui).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Default OPTIMAL /solve answer: lay the posted activities end to end.
function defaultSolve(body) {
  let t = 0;
  const schedule = (body.activities || []).map((a) => {
    const start = t;
    t += a.duration || 30;
    return { id: a.id, start, end: t };
  });
  return { status: "OPTIMAL", schedule, horizon: body.horizon || 1440 };
}

// Load the app. `responses` maps a POST path ("/solve", "/relax", ...) to either a plain
// object (returned as the JSON body) or a function (body, call) -> object. GETs for
// static/library.json, /examples and /example/<name> are served from the real files.
export async function loadApp({ responses = {} } = {}) {
  const html = (await readFile(path.join(ROOT, "templates", "index.html"), "utf8"))
    // Jinja -> plain paths ({{ url_for('static', filename='X') }} -> "static/X").
    .replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, "static/$1");

  // Surface page errors instead of swallowing them (jsdom reports script crashes here).
  const errors = [];
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => errors.push(e));

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  const { document } = window;

  // ---- fetch mock (installed BEFORE app.js runs) --------------------------
  const calls = [];
  const routes = { ...responses }; // mutable, so a test can swap a route mid-run

  const jsonRes = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => data,
  });

  async function serveFile(rel) {
    try {
      return jsonRes(JSON.parse(await readFile(path.join(ROOT, rel), "utf8")));
    } catch {
      return jsonRes({ error: `no such file: ${rel}` }, 404);
    }
  }

  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    let p = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (!p.startsWith("/")) p = "/" + p;
    let body = opts.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* keep the raw string */ }
    }
    const call = { method, url: p, body };
    calls.push(call);

    if (method === "GET") {
      if (p.startsWith("/static/")) return serveFile(p.slice(1));
      if (p === "/examples") return serveFile("examples/manifest.json");
      const m = p.match(/^\/example\/([\w.-]+)$/);
      if (m) return serveFile(path.join("examples", m[1] + ".json"));
      return jsonRes({ error: `no GET mock for ${p}` }, 404);
    }

    let r = routes[p];
    if (r === undefined && p === "/solve") r = defaultSolve;
    if (r === undefined) return jsonRes({ error: `no POST mock for ${p}` }, 404);
    return jsonRes(typeof r === "function" ? await r(body, call) : r);
  };

  // ---- shims for APIs jsdom lacks (or stubs loudly) ------------------------
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => null;
  if (!window.matchMedia)
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver)
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!window.Element.prototype.scrollIntoView)
    window.Element.prototype.scrollIntoView = () => {};
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = () => "blob:mock";
    window.URL.revokeObjectURL = () => {};
  }

  // ---- evaluate app.js as a real classic <script> --------------------------
  // This puts top-level `function`s on window and top-level let/const in the global lexical
  // scope, which `run(code)` below (page eval) can still read and assign.
  const src = await readFile(path.join(ROOT, "static", "app.js"), "utf8");
  const script = document.createElement("script");
  script.textContent = src;
  document.body.append(script);

  // Wait real timers: default just flushes microtasks + a tick.
  const flush = (ms = 0) => new Promise((res) => setTimeout(res, ms + 5));
  // Evaluate code in the page, e.g. run("scenario") or run("render()").
  const run = (code) => window.eval(code);

  await flush(30); // let the boot IIFE (library + examples fetches, first render) settle

  return {
    window,
    document,
    calls,
    responses: routes,
    errors,
    flush,
    run,
    close: () => window.close(), // clears jsdom timers so node --test exits promptly
  };
}
