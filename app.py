# Flask app: serves the dashboard and three JSON endpoints.
import json  # noqa: E402
from pathlib import Path  # noqa: E402

from dotenv import load_dotenv

load_dotenv()  # load ANTHROPIC_API_KEY from .env before anything uses it

from flask import Flask, jsonify, render_template, request  # noqa: E402

from models import Scenario  # noqa: E402
from parse import parse_sentence  # noqa: E402
from solver import solve  # noqa: E402

app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/example")
def example_route():
    # The hand-written demo IR, so the dashboard is usable without an API key.
    path = Path(__file__).parent / "examples" / "lake.json"
    return jsonify(json.loads(path.read_text()))


@app.post("/parse")
def parse_route():
    sentence = request.json["sentence"]
    return jsonify(parse_sentence(sentence).model_dump())


@app.post("/solve")
def solve_route():
    scenario = Scenario.model_validate(request.json)
    return jsonify(solve(scenario))


if __name__ == "__main__":
    app.run(debug=True, port=5000)
