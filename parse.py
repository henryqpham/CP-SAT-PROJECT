# Turn a plain-English sentence into a validated IR (models.Scenario) with a
# LOCAL Ollama model — no API key, runs offline. The model only DRAFTS the JSON;
# Pydantic validates it and the dashboard lets you review/edit before solving.
import os

import ollama

from models import Scenario

# Local model served by Ollama at http://localhost:11434. Override via OLLAMA_MODEL.
MODEL = os.environ.get("OLLAMA_MODEL", "granite4.1:8b")

SYSTEM = """You convert a plain-English description of a day into a scheduling IR.

Output ONLY a JSON object: {"activities": [...], "constraints": [...], optional "day": {...}}.

activities: [{"id": "<snake_case>", "duration": <minutes>}]

day (OPTIONAL): {"start": "HH:MM", "end": "HH:MM"} — ONLY when the sentence states the
WHOLE day's bounds ("my day runs 8am to 10pm", "I'm free 9 to 5"). It bounds EVERY
activity. Omit it entirely if no overall span is given. A lone "after 8 AM" or "home by
10 PM" is a time_window on ONE activity, not a day window.

constraints: each has "id", "type", "enabled" (true), "label", and "source"
(the exact phrase it came from). One of:
  {"type": "time_window", "activity": "<id>", "earliest": "HH:MM", "latest_end": "HH:MM"}
  {"type": "no_overlap", "activities": "all"}                  // EVERY activity is mutually exclusive
  {"type": "no_overlap", "activities": ["<id>", "<id>"]}       // ONLY these named activities are mutually exclusive
  {"type": "precedence", "before": "<id>", "after": "<id>"}
  {"type": "sequence", "activities": ["<id>", "<id>", ...]}  // ordered chain: each ends before the next begins
  {"type": "conditional",
   "when": {"activity": "<id>", "present": false},
   "then": {"set_duration": {"activity": "<id>", "factor": 2}}}

Pick each constraint "type" by the phrase — do NOT default everything to no_overlap:
- a clock time ("after 8 AM", "by 10 PM", "between 1 and 3") -> time_window (earliest and/or latest_end, "HH:MM")
- ONE ordering of exactly two activities ("do X before Y", "Y after X") -> precedence (before, after)
- a CHAIN of 2+ activities in a stated order ("first X, then Y, then Z", "X, then Y, finally Z",
  "do these in order: X, Y, Z", "X before Y before Z") -> ONE sequence listing the ids in order
- "make X last" / "X should be the last thing": there is no 'make last' primitive — when the full
  order is known or implied, encode it as a sequence ending in X; if only some activities' order is
  stated, use a sequence of just those, in order
- a day that MOVES between activities or places proceeds in the order they are mentioned: when the
  sentence narrates a series of activities (even without "first/then/finally"), emit ONE sequence
  listing the ids in mention order. Do NOT emit a sequence when the text says order doesn't matter
  ("sometime", "in any order", "whenever").
- "if I can't / skip / don't X, then <do Y longer or more>" -> conditional (when.present=false + then.set_duration)
- activities can't overlap / "one thing at a time" -> no_overlap. Use "all" only when EVERY
  activity is mutually exclusive; if only specific named activities can't overlap, list just those ids.

Rules:
- Map ONLY what the sentence states. Do not invent unstated constraints.
- "back by / home by X" is a latest_end on the going-home activity, not a start time.
- A time_window targets ONE named activity (a real activity id, never "all"). An overall
  day span ("between 9 and 4", "my day runs 8 to 10") goes in `day` ONLY — do NOT also add a
  time_window for it.
- Use no_overlap only for non-overlap; never for times, ordering, or conditionals.
- Give every constraint the exact source phrase so a human can review it.

Example —
Sentence: "My day runs 8 AM to 10 PM. Go to the lake, leave after 8 AM, grab a hamburger, sail, maybe kiteboard, and if I can't kiteboard sail twice as long, be home by 10 PM."
JSON: {"day":{"start":"08:00","end":"22:00"},"activities":[{"id":"drive_to_lake","duration":90},{"id":"hamburger","duration":30},{"id":"sail","duration":120},{"id":"kiteboard","duration":120},{"id":"drive_home","duration":90}],"constraints":[{"id":"c1","type":"time_window","activity":"drive_to_lake","earliest":"08:00","enabled":true,"label":"Leave after 8 AM","source":"leave after 8 AM"},{"id":"c2","type":"time_window","activity":"drive_home","latest_end":"22:00","enabled":true,"label":"Home by 10 PM","source":"be home by 10 PM"},{"id":"c3","type":"no_overlap","activities":"all","enabled":true,"label":"One thing at a time","source":""},{"id":"c4","type":"sequence","activities":["drive_to_lake","hamburger","sail","kiteboard","drive_home"],"enabled":true,"label":"Move through the day in order","source":"go to the lake, grab a hamburger, sail, maybe kiteboard, be home"},{"id":"c5","type":"conditional","when":{"activity":"kiteboard","present":false},"then":{"set_duration":{"activity":"sail","factor":2}},"enabled":true,"label":"If no kite, sail twice as long","source":"if I can't kiteboard, sail twice as long"}]}

Example (ordered chain) —
Sentence: "First make coffee, then eat breakfast, then go for a run, and finally take a shower."
JSON: {"activities":[{"id":"make_coffee","duration":10},{"id":"eat_breakfast","duration":20},{"id":"go_for_a_run","duration":40},{"id":"take_a_shower","duration":15}],"constraints":[{"id":"c1","type":"sequence","activities":["make_coffee","eat_breakfast","go_for_a_run","take_a_shower"],"enabled":true,"label":"Morning order","source":"first make coffee, then eat breakfast, then go for a run, and finally take a shower"}]}
"""


def parse_sentence(sentence: str) -> Scenario:
    raw = _ask(sentence)
    try:
        return Scenario.model_validate_json(raw)
    except Exception as e:  # one repair attempt: hand the error back
        raw = _ask(sentence, repair=str(e), previous=raw)
        return Scenario.model_validate_json(raw)


def _ask(sentence: str, repair: str = "", previous: str = "") -> str:
    content = sentence
    if repair:
        content = (
            f"Your previous output failed validation:\n{repair}\n\n"
            f"Previous output:\n{previous}\n\nReturn corrected JSON only."
        )
    try:
        msg = ollama.chat(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": content},
            ],
            format="json",  # valid-JSON mode; Pydantic checks the structure, repair-retry on failure
            # num_ctx raised from Ollama's ~4K default so longer inputs aren't silently truncated.
            # 16384 ≈ ~25 pages; feed long docs in portions. On a small GPU this partly offloads to CPU.
            # repeat_penalty 1.0 (not the 1.1 default): times like "09:00" legitimately repeat across
            # constraints, and penalizing repeats can corrupt the JSON.
            options={"temperature": 0, "num_predict": 2048, "num_ctx": 16384, "repeat_penalty": 1.0},
        )
    except Exception as e:  # Ollama not running, or model not pulled
        raise RuntimeError(
            f"Could not reach local Ollama model '{MODEL}'. Is Ollama running and the "
            f"model pulled (`ollama pull {MODEL}`)? Original error: {e}"
        )
    return _strip_fences(msg.message.content.strip())


def _strip_fences(text: str) -> str:
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
    return text.strip()
