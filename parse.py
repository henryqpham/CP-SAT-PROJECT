# Turn a plain-English sentence into a validated IR (models.Scenario) with a
# LOCAL Ollama model — no API key, runs offline. The model only DRAFTS the JSON;
# Pydantic validates it and the dashboard lets you review/edit before solving.
import os

import ollama

from models import Scenario

# Local model served by Ollama at http://localhost:11434. Override via OLLAMA_MODEL.
MODEL = os.environ.get("OLLAMA_MODEL", "granite4.1:8b")

SYSTEM = """You convert a plain-English description of a day or multi-day plan into a scheduling IR.

Output ONLY a JSON object: {"activities": [...], "constraints": [...]}.

activities: [{"id": "<snake_case>", "duration": <minutes>}]

constraints: each has "id", "type", "enabled" (true), "label", and "source"
(the exact phrase it came from). One of:
  {"type": "time_window", "activity": "<id>", "earliest": "HH:MM", "latest_end": "HH:MM", "day": <0-based day, omit for day 1>}
  {"type": "no_overlap", "activities": "all"}                  // EVERY activity is mutually exclusive
  {"type": "no_overlap", "activities": ["<id>", "<id>"]}       // ONLY these named activities are mutually exclusive
  {"type": "precedence", "before": "<id>", "after": "<id>"}
  {"type": "sequence", "activities": ["<id>", "<id>", ...]}  // ordered chain: each ends before the next begins
  {"type": "working_window", "section": "<name or 'all'>", "open": "HH:MM", "close": "HH:MM"}  // open hours that REPEAT every day
  {"type": "overlap", "outer": "<id>", "inner": "<id>", "mode": "contains"}  // outer covers inner the WHOLE time
  {"type": "overlap", "outer": "<id>", "inner": "<id>", "mode": "overlaps"}  // the two just SHARE some time
  {"type": "section_budget", "section": "<name>", "max_minutes": <int>}      // cap total minutes in a section
  {"type": "time_lag", "from_id": "<id>", "to_id": "<id>", "from_anchor": "end", "to_anchor": "start", "min_lag": <int|null>, "max_lag": <int|null>}  // bound the GAP (minutes) between two activities
  {"type": "min_separation", "a": "<id>", "b": "<id>", "gap": <int>}         // keep two activities >= gap minutes apart (a real buffer)
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
- "if I can't / skip / don't X, then <do Y longer or more>" -> conditional (when.present=false + then.set_duration)
- activities can't overlap / "one thing at a time" -> no_overlap. Use "all" only when EVERY
  activity is mutually exclusive; if only specific named activities can't overlap, list just those ids.
- "X runs/stays DURING Y", "keep Y covered the whole time", "Z must cover the EVA" -> overlap, mode
  "contains" (outer = the covering/longer activity, inner = the one held inside it)
- "X and Y happen at the same time" / "must overlap" -> overlap, mode "overlaps"
- a clock time tied to a DAY ("by 18:00 on day 3", "starts day 2") -> time_window with "day"
  (0-based: "day 3" -> 2, "day 1" or no day given -> omit it)
- a section's hours that repeat EACH day ("the lab is open 9 to 5", "station staffed 08:00-20:00")
  -> working_window (a daily clock), NOT time_window (which is a one-day deadline)
- "no more than N hours of <section> total", "cap <section> at H hours" -> section_budget (max_minutes)
- "X IMMEDIATELY before/after Y", "right before", "back-to-back" -> time_lag from_id X to_id Y,
  from_anchor end, to_anchor start, min_lag 0, max_lag 0 (a zero gap)
- "no more than N between X and Y", "X within N of Y", "meals <= 6h apart" -> time_lag end->start,
  max_lag = N in MINUTES (one per consecutive pair)
- "no more than N from <wake/start> to <something>", "awake <= 16h30 from wake to pre-sleep" ->
  time_lag with the right anchors (e.g. end of sleep -> start of pre_sleep), max_lag = N minutes
- "keep X at least N away from Y", ">= N buffer between activities", "not within 30m of a meal" ->
  min_separation (a, b, gap=N) -- NOT no_overlap, which lets activities touch

Rules:
- Map ONLY what the sentence states. Do not invent unstated constraints.
- time_lag and min_separation are in MINUTES (6h = 360, 16h30 = 990, 30 min = 30).
- "back by / home by X" is a latest_end on the going-home activity, not a start time.
- A time_window targets ONE named activity (a real activity id, never "all").
- Use no_overlap only for non-overlap; never for times, ordering, or conditionals.
- Give every constraint the exact source phrase so a human can review it.

Example —
Sentence: "Go to the lake, leave after 8 AM, grab a hamburger, sail, maybe kiteboard, and if I can't kiteboard sail twice as long, be home by 10 PM."
JSON: {"activities":[{"id":"drive_to_lake","duration":90},{"id":"hamburger","duration":30},{"id":"sail","duration":120},{"id":"kiteboard","duration":120},{"id":"drive_home","duration":90}],"constraints":[{"id":"c1","type":"time_window","activity":"drive_to_lake","earliest":"08:00","enabled":true,"label":"Leave after 8 AM","source":"leave after 8 AM"},{"id":"c2","type":"time_window","activity":"drive_home","latest_end":"22:00","enabled":true,"label":"Home by 10 PM","source":"be home by 10 PM"},{"id":"c3","type":"no_overlap","activities":"all","enabled":true,"label":"One thing at a time","source":""},{"id":"c4","type":"precedence","before":"drive_to_lake","after":"sail","enabled":true,"label":"Drive before sailing","source":""},{"id":"c5","type":"conditional","when":{"activity":"kiteboard","present":false},"then":{"set_duration":{"activity":"sail","factor":2}},"enabled":true,"label":"If no kite, sail twice as long","source":"if I can't kiteboard, sail twice as long"}]}

Example (ordered chain) —
Sentence: "First make coffee, then eat breakfast, then go for a run, and finally take a shower."
JSON: {"activities":[{"id":"make_coffee","duration":10},{"id":"eat_breakfast","duration":20},{"id":"go_for_a_run","duration":40},{"id":"take_a_shower","duration":15}],"constraints":[{"id":"c1","type":"sequence","activities":["make_coffee","eat_breakfast","go_for_a_run","take_a_shower"],"enabled":true,"label":"Morning order","source":"first make coffee, then eat breakfast, then go for a run, and finally take a shower"}]}

Example (coverage during + per-day deadline) —
Sentence: "EVA prep takes 2 hours and must finish before the EVA, which runs 6 hours. Keep comms coverage running during the entire EVA, and undock by 18:00 on day 3."
JSON: {"activities":[{"id":"eva_prep","duration":120},{"id":"eva","duration":360},{"id":"comms_coverage","duration":360},{"id":"undock","duration":30}],"constraints":[{"id":"c1","type":"precedence","before":"eva_prep","after":"eva","enabled":true,"label":"Prep before EVA","source":"must finish before the EVA"},{"id":"c2","type":"overlap","outer":"comms_coverage","inner":"eva","mode":"contains","enabled":true,"label":"Comms covers the EVA","source":"Keep comms coverage running during the entire EVA"},{"id":"c3","type":"time_window","activity":"undock","latest_end":"18:00","day":2,"enabled":true,"label":"Undock by 18:00 on day 3","source":"undock by 18:00 on day 3"}]}

Example (daily hours + section budget — these carry "source" too) —
Sentence: "The comms station is staffed 08:00 to 20:00 every day, and keep total science work under 4 hours."
JSON: {"activities":[{"id":"science_run","duration":120,"section":"science"}],"constraints":[{"id":"c1","type":"working_window","section":"all","open":"08:00","close":"20:00","enabled":true,"label":"Comms staffed 08:00-20:00","source":"comms station is staffed 08:00 to 20:00 every day"},{"id":"c2","type":"section_budget","section":"science","max_minutes":240,"enabled":true,"label":"Science under 4h","source":"keep total science work under 4 hours"}]}

Example (relative timing — immediately / within / apart) —
Sentence: "Pre-sleep is 45 min right before sleep. Keep breakfast and lunch no more than 6 hours apart. Exercise must stay at least 30 minutes away from lunch."
JSON: {"activities":[{"id":"pre_sleep","duration":45},{"id":"sleep","duration":495},{"id":"breakfast","duration":45},{"id":"lunch","duration":45},{"id":"exercise","duration":60}],"constraints":[{"id":"c1","type":"time_lag","from_id":"pre_sleep","to_id":"sleep","from_anchor":"end","to_anchor":"start","min_lag":0,"max_lag":0,"enabled":true,"label":"Pre-sleep right before sleep","source":"Pre-sleep is 45 min right before sleep"},{"id":"c2","type":"time_lag","from_id":"breakfast","to_id":"lunch","from_anchor":"end","to_anchor":"start","max_lag":360,"enabled":true,"label":"Breakfast to lunch <= 6h","source":"breakfast and lunch no more than 6 hours apart"},{"id":"c3","type":"min_separation","a":"exercise","b":"lunch","gap":30,"enabled":true,"label":"Exercise 30m from lunch","source":"Exercise must stay at least 30 minutes away from lunch"}]}
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
            format="json",  # make the model return valid JSON; Pydantic then checks the structure
            # num_ctx is the model's memory window. We raise it well above Ollama's
            # small default so long inputs aren't cut off.
            options={"temperature": 0, "num_predict": 2048, "num_ctx": 16384},
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
