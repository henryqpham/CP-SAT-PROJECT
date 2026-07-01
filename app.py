# Flask app: serves the dashboard and the JSON endpoints.
import json
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # load any .env settings (e.g. OLLAMA_MODEL) before anything uses them

from flask import Flask, jsonify, render_template, request  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from models import Scenario  # noqa: E402
from parse import parse_sentence  # noqa: E402
from solver import explain_infeasible, relax_by_priority, solve  # noqa: E402

app = Flask(__name__)
# Dev: don't let the browser cache static JS/CSS, so code edits show on a normal refresh
# (avoids the "I fixed it but the page still shows the old behavior" stale-cache trap).
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


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


def _scenario_or_error(body):
    """Validate a posted JSON body into a Scenario. Returns (scenario, None) on success, or
    (None, flask_error_response) on a bad/missing body — shared by /solve and /explain."""
    if body is None:
        return None, (jsonify({"error": "Send a JSON scenario body."}), 400)
    try:
        return Scenario.model_validate(body), None
    except ValidationError as e:
        # The schedule was invalid (missing fields, bad HH:MM time, etc.). Turn each error into a
        # small {location, message} pair the browser can show. We keep only these text fields
        # because the full error also holds a raw exception that can't be turned into JSON.
        details = [{"loc": ".".join(str(p) for p in err["loc"]),
                    "message": err["msg"]} for err in e.errors()]
        return None, (jsonify({"error": "That schedule isn't valid.", "details": details}), 400)


@app.post("/solve")
def solve_route():
    scenario, err = _scenario_or_error(request.get_json(silent=True))
    if err:
        return err
    return jsonify(solve(scenario))


@app.post("/explain")
def explain_route():
    # On-demand "why is this INFEASIBLE?": returns a minimal set of conflicting constraint ids.
    scenario, err = _scenario_or_error(request.get_json(silent=True))
    if err:
        return err
    return jsonify(explain_infeasible(scenario))


@app.post("/relax")
def relax_route():
    # On-demand priority-ordered relaxation: which LOWEST-priority rules to drop to make it solve.
    scenario, err = _scenario_or_error(request.get_json(silent=True))
    if err:
        return err
    return jsonify(relax_by_priority(scenario))


if __name__ == "__main__":
    app.run(debug=True, port=5000)
