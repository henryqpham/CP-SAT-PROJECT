# Turn a plain-English sentence into a validated IR (models.Scenario).
# Claude drafts the JSON; Pydantic validates it; one repair retry on failure.
import anthropic

from models import Scenario

MODEL = "claude-opus-4-8"
_client = None

SYSTEM = """You convert a plain-English description of a day into a scheduling IR.

Output ONLY a JSON object: {"activities": [...], "constraints": [...]}.

activities: [{"id": "<snake_case>", "duration": <minutes>}]

constraints: each has "id", "type", "enabled" (true), "label", and "source"
(the exact phrase it came from). One of:
  {"type": "time_window", "activity": "<id>", "earliest": "HH:MM", "latest_end": "HH:MM"}
  {"type": "no_overlap", "activities": "all"}
  {"type": "precedence", "before": "<id>", "after": "<id>"}
  {"type": "conditional",
   "when": {"activity": "<id>", "present": false},
   "then": {"set_duration": {"activity": "<id>", "factor": 2}}}

Rules:
- Map ONLY what the sentence states. Do not invent unstated constraints.
- "back by / home by X" is a latest_end on the going-home activity, not a start time.
- Give every constraint the exact source phrase so a human can review it.
"""


def parse_sentence(sentence: str) -> Scenario:
    raw = _ask(sentence)
    try:
        return Scenario.model_validate_json(raw)
    except Exception as e:  # one repair attempt: hand the error back
        raw = _ask(sentence, repair=str(e), previous=raw)
        return Scenario.model_validate_json(raw)


def _ask(sentence: str, repair: str = "", previous: str = "") -> str:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    content = sentence
    if repair:
        content = (
            f"Your previous output failed validation:\n{repair}\n\n"
            f"Previous output:\n{previous}\n\nReturn corrected JSON only."
        )
    msg = _client.messages.create(
        model=MODEL,
        max_tokens=2000,
        system=SYSTEM,
        messages=[{"role": "user", "content": content}],
    )
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    return _strip_fences(text)


def _strip_fences(text: str) -> str:
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
    return text.strip()
