# Flask app: serves the dashboard and the JSON endpoints.
import io
import json
import queue
import re
import threading
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # load any .env settings (e.g. OLLAMA_MODEL) before anything uses them

from flask import Flask, Request, Response, jsonify, render_template, request  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from extract import extract_document  # noqa: E402
from ingest import extract_blocks  # noqa: E402
from models import Scenario  # noqa: E402
from parse import parse_sentence  # noqa: E402
from solver import explain_infeasibility, solve  # noqa: E402

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # cap upload size (bounds memory + the zip-bomb amplifier)


class _InMemoryRequest(Request):
    # Keep uploaded files entirely in memory instead of letting Werkzeug spool parts
    # over ~500 KB to an OS temp file — so a .docx's bytes never touch the disk (privacy).
    # Bounded by MAX_CONTENT_LENGTH below.
    def _get_file_stream(self, total_content_length, content_type, filename=None, content_length=None):
        return io.BytesIO()


app = Flask(__name__)
app.request_class = _InMemoryRequest
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


@app.errorhandler(413)
def _too_large(e):
    return jsonify({"error": f"File too large (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)."}), 413


@app.get("/")
def index():
    return render_template("index.html")


EXAMPLES_DIR = Path(__file__).parent / "examples"
_EXAMPLE_NAME = re.compile(r"^[a-z0-9_]+$")


@app.get("/examples")
def examples_list():
    # Names + titles for the dashboard's example dropdown.
    return jsonify(json.loads((EXAMPLES_DIR / "manifest.json").read_text()))


@app.get("/example")
@app.get("/example/<name>")
def example_route(name="lake"):
    # A hand-written demo IR, so the dashboard is usable without the LLM running.
    if not _EXAMPLE_NAME.match(name):
        return jsonify({"error": "invalid example name"}), 400
    path = EXAMPLES_DIR / f"{name}.json"
    if not path.exists():
        return jsonify({"error": f"no example named '{name}'"}), 404
    return jsonify(json.loads(path.read_text()))


@app.post("/parse")
def parse_route():
    sentence = (request.json or {}).get("sentence", "").strip()
    if not sentence:
        return jsonify({"error": "Type a sentence first."}), 400
    try:
        return jsonify(parse_sentence(sentence).model_dump())
    except RuntimeError as e:  # Ollama not running / model not pulled
        return jsonify({"error": str(e)}), 503
    except Exception:  # the model's JSON didn't match the schema, etc.
        return jsonify({"error": "The model couldn't turn that into a valid schedule. "
                                 "Try rephrasing, or build it by hand / Load an example."}), 502


@app.post("/solve")
def solve_route():
    body = request.json if request.is_json else None
    if body is None:
        return jsonify({"error": "Send a JSON scenario body."}), 400
    try:
        scenario = Scenario.model_validate(body)
    except ValidationError as e:
        # Bad/invalid IR (missing fields, malformed HH:MM, …) — a client error.
        # Keep only the JSON-safe bits of each error (drop the raw exception in
        # `ctx`, which isn't serializable).
        details = [{"loc": ".".join(str(p) for p in err["loc"]),
                    "message": err["msg"]} for err in e.errors()]
        return jsonify({"error": "That schedule isn't valid.",
                        "details": details}), 400
    result = solve(scenario)
    if result.get("status") == "INFEASIBLE":
        # Second pass (only on failure): name the conflicting requirements so the user
        # can see WHY no schedule fits, not just that none does.
        conflict = explain_infeasibility(scenario)
        if conflict:
            result["conflict"] = conflict
    return jsonify(result)


@app.post("/upload")
def upload_route():
    # Extract structured blocks from a .docx, all in memory — nothing is saved
    # to disk and nothing leaves the machine (privacy, per CLAUDE.md).
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "Attach a .docx file under the 'file' field."}), 400
    if not file.filename.lower().endswith(".docx"):
        return jsonify({"error": "Only .docx files are supported."}), 400
    try:
        # FileStorage.stream is the in-memory file-like object python-docx reads.
        return jsonify(extract_blocks(file.stream))
    except Exception:  # corrupt / not really a .docx
        return jsonify({"error": "Could not read that .docx — is it a valid Word document?"}), 400


@app.post("/extract")
def extract_route():
    # Turn /upload's structured blocks into a validated multi-day Scenario via the
    # deterministic-first pipeline (rules resolve most of it; the local model is a scoped
    # fallback for the residual). We STREAM progress over Server-Sent Events and run the
    # work in a thread, since a residual model call can still take seconds on a small GPU.
    # Even if the model is unreachable, the deterministic backbone returns a full scenario
    # — any gaps are surfaced via `warnings` and the coverage report.
    body = request.get_json(silent=True) or {}
    blocks = body.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return jsonify({"error": 'Send {"blocks": [...]} from /upload first.'}), 400

    def generate():
        q: queue.Queue = queue.Queue()

        def progress(i, n, label):
            q.put({"type": "progress", "i": i, "n": n, "label": label})

        def work():
            try:
                result = extract_document(blocks, progress=progress)
                q.put({"type": "done", **result})
            except Exception as e:  # unexpected hard failure
                q.put({"type": "error", "error": f"Extraction failed: {e}"})
            finally:
                q.put(None)  # sentinel: stream complete

        threading.Thread(target=work, daemon=True).start()
        while True:
            item = q.get()
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
