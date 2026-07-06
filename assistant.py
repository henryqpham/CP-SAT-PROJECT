"""The in-app plan assistant: natural-language edits through TYPED tools.

The local model never touches the plan directly. It calls tools (add_activity,
set_duration, add_constraint, ...); each tool applies the change to a COPY of
the scenario and re-validates it with the same Pydantic IR as a manual edit —
an invalid change bounces back to the model as an error instead of reaching
the plan. The browser then applies the returned scenario through the normal
history/undo/re-solve path, so every assistant edit is one Ctrl+Z away.

Plain Ollama native tool-calling (no framework). Ollama down = the feature is
unavailable (503), the app is otherwise fine.
"""
import json
import re

import ollama
from pydantic import ValidationError

from models import Scenario
from parse import MODEL
import solver

MAX_ROUNDS = 8  # tool-call rounds per message — a runaway-loop backstop

_SYSTEM = """You are the planning assistant inside a schedule what-if tool.
You change the plan ONLY by calling the tools. Rules:
- Activities have an id (snake_case), a duration in MINUTES, and optionally a section.
- Convert times to minutes (1h = 60). Refer to activities by their exact id from the plan.
- After making the requested edits, call solve once to check the plan still fits, and say so.
- If the plan is INFEASIBLE, you may call explain_infeasible and report which rules clash.
- Only do what the user asked — no extra edits. If the request is unclear or the id doesn't
  exist, say so instead of guessing.
- Keep the final reply to one or two short sentences.
"""

# The constraint cheat-sheet for add_constraint (kept short for a small local model).
_CONSTRAINT_HELP = (
    'A constraint object needs "type" plus its fields: '
    '{"type":"time_window","activity":id,"earliest":"HH:MM","latest_end":"HH:MM","day":0}; '
    '{"type":"precedence","before":id,"after":id}; '
    '{"type":"sequence","activities":[ids in order]}; '
    '{"type":"no_overlap","activities":"all" or [ids]}; '
    '{"type":"overlap","outer":id,"inner":id,"mode":"contains"|"overlaps"}; '
    '{"type":"working_window","section":name or "all","open":"HH:MM","close":"HH:MM"}; '
    '{"type":"section_budget","section":name,"max_minutes":int}; '
    '{"type":"time_lag","from_id":id,"to_id":id,"from_anchor":"end","to_anchor":"start",'
    '"min_lag":int|null,"max_lag":int|null}; '
    '{"type":"min_separation","a":id,"b":id,"gap":int}. '
    'Optional on all: "label", "priority" (1 hard .. 5 droppable), "rationale".'
)

TOOLS = [
    {"type": "function", "function": {
        "name": "add_activity",
        "description": "Add a new activity to the plan.",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "string", "description": "snake_case id, unique"},
            "duration": {"type": "integer", "description": "minutes"},
            "section": {"type": "string", "description": "optional section/resource name"},
            "recurs_daily": {"type": "boolean", "description": "one occurrence per day"},
        }, "required": ["id", "duration"]}}},
    {"type": "function", "function": {
        "name": "remove_activity",
        "description": "Remove an activity from the plan by id.",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "string"}}, "required": ["id"]}}},
    {"type": "function", "function": {
        "name": "set_duration",
        "description": "Change an activity's duration (minutes).",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "string"},
            "duration": {"type": "integer", "description": "minutes"},
        }, "required": ["id", "duration"]}}},
    {"type": "function", "function": {
        "name": "add_constraint",
        "description": "Add a scheduling rule. " + _CONSTRAINT_HELP,
        "parameters": {"type": "object", "properties": {
            "constraint": {"type": "object", "description": "the constraint object"},
        }, "required": ["constraint"]}}},
    {"type": "function", "function": {
        "name": "toggle_constraint",
        "description": "Enable or disable a constraint by its id.",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "string"},
            "enabled": {"type": "boolean"},
        }, "required": ["id", "enabled"]}}},
    {"type": "function", "function": {
        "name": "solve",
        "description": "Solve the current plan; returns the status and how it fits.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "explain_infeasible",
        "description": "For an infeasible plan: which enabled rules conflict.",
        "parameters": {"type": "object", "properties": {}}}},
]


def _flat(text, cap=60):
    """Collapse whitespace and cap length — labels can come from an imported doc,
    and a multi-line label must not smuggle instructions into the prompt."""
    return re.sub(r"\s+", " ", str(text or "")).strip()[:cap]


def _plan_summary(sc: dict) -> str:
    """A compact plan snapshot the model can ground its edits in."""
    acts = [{k: v for k, v in a.items()
             if k in ("id", "duration", "section", "recurs_daily") and v not in (None, False)}
            for a in sc.get("activities", [])]
    cons = [{"id": c["id"], "type": c["type"], "label": _flat(c.get("label")),
             "enabled": c["enabled"], "priority": c.get("priority", 1)}
            for c in sc.get("constraints", [])]
    return json.dumps({"activities": acts, "constraints": cons,
                       "horizon_minutes": sc.get("horizon")}, separators=(",", ":"))


class _Workspace:
    """The scenario being edited. Every mutation re-validates through the IR;
    a bad change raises and is reported back to the model, never applied."""

    def __init__(self, scenario: Scenario):
        self.data = scenario.model_dump()
        self.actions: list[str] = []
        self.changed = False

    def _try(self, mutate, describe: str) -> str:
        trial = json.loads(json.dumps(self.data))
        mutate(trial)
        try:
            self.data = Scenario.model_validate(trial).model_dump()
        except ValidationError as e:
            first = e.errors()[0]
            raise ValueError(f"invalid change: {first['msg']}")
        self.actions.append(describe)
        self.changed = True
        return "ok — " + describe

    # ---- tools -----------------------------------------------------------
    def add_activity(self, id, duration, section=None, recurs_daily=False):
        if any(a["id"] == id for a in self.data["activities"]):
            raise ValueError(f"an activity with id '{id}' already exists")
        act = {"id": id, "duration": int(duration)}
        if section:
            act["section"] = section
        if recurs_daily:
            act["recurs_daily"] = True
        return self._try(lambda sc: sc["activities"].append(act),
                         f"added activity {id} ({int(duration)}m"
                         + (f", section {section}" if section else "") + ")")

    def remove_activity(self, id):
        if not any(a["id"] == id for a in self.data["activities"]):
            raise ValueError(f"no activity with id '{id}'")

        def mutate(sc):
            sc["activities"] = [a for a in sc["activities"] if a["id"] != id]
        return self._try(mutate, f"removed activity {id}")

    def set_duration(self, id, duration):
        if not any(a["id"] == id for a in self.data["activities"]):
            raise ValueError(f"no activity with id '{id}'")

        def mutate(sc):
            for a in sc["activities"]:
                if a["id"] == id:
                    a["duration"] = int(duration)
        return self._try(mutate, f"set {id} duration to {int(duration)}m")

    def add_constraint(self, constraint):
        if not isinstance(constraint, dict) or "type" not in constraint:
            raise ValueError('the constraint must be an object with a "type"')
        constraint.setdefault("enabled", True)
        return self._try(lambda sc: sc["constraints"].append(constraint),
                         f"added {constraint.get('type')} constraint"
                         + (f" '{constraint.get('label')}'" if constraint.get("label") else ""))

    def toggle_constraint(self, id, enabled):
        if not any(c["id"] == id for c in self.data["constraints"]):
            raise ValueError(f"no constraint with id '{id}'")

        def mutate(sc):
            for c in sc["constraints"]:
                if c["id"] == id:
                    c["enabled"] = bool(enabled)
        return self._try(mutate, f"{'enabled' if enabled else 'disabled'} constraint {id}")

    def solve(self):
        out = solver.solve(Scenario.model_validate(self.data))
        if out["status"] != "OPTIMAL":
            return f"status: {out['status']}"
        end = max((s["end"] for s in out["schedule"]), default=0)
        return (f"status: OPTIMAL — {len(out['schedule'])} scheduled, "
                f"finishes at minute {end} of {out['horizon']}")

    def explain_infeasible(self):
        exp = solver.explain_infeasible(Scenario.model_validate(self.data))
        if exp.get("structural"):
            return "structurally infeasible: the activities don't fit the horizon at all"
        by_id = {c["id"]: c for c in self.data["constraints"]}
        names = [f"{i} ({by_id[i]['type']}: {by_id[i].get('label') or ''})".strip()
                 for i in exp.get("conflict_ids", []) if i in by_id]
        return "conflicting rules: " + (", ".join(names) or "none")


def _ollama_chat(messages, tools):
    try:
        return ollama.chat(model=MODEL, messages=messages, tools=tools,
                           options={"temperature": 0, "num_predict": 1024, "num_ctx": 16384})
    except Exception as e:
        raise RuntimeError(
            f"Could not reach local Ollama model '{MODEL}'. Is Ollama running and the "
            f"model pulled (`ollama pull {MODEL}`)? Original error: {e}"
        )


def _parts(response):
    """(content, tool_calls) from an ollama ChatResponse OR a plain dict (tests)."""
    msg = response["message"] if isinstance(response, dict) else response.message
    if isinstance(msg, dict):
        return msg.get("content") or "", msg.get("tool_calls") or []
    return msg.content or "", list(msg.tool_calls or [])


def _call_parts(call):
    """(name, arguments) from a tool call object or dict."""
    fn = call["function"] if isinstance(call, dict) else call.function
    if isinstance(fn, dict):
        return fn.get("name"), fn.get("arguments") or {}
    return fn.name, dict(fn.arguments or {})


def assist(message: str, scenario: Scenario, chat_fn=None) -> dict:
    """One assistant turn: run the tool-calling loop and return
    {"reply", "scenario", "changed", "actions"}.

    `chat_fn(messages, tools)` is injectable so the loop is testable without
    Ollama (resolved at call time, so monkeypatching _ollama_chat works too).
    Raises RuntimeError when the local model can't be reached.
    """
    chat_fn = chat_fn or _ollama_chat
    ws = _Workspace(scenario)
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": f"Current plan: {_plan_summary(ws.data)}\n\n{message}"},
    ]

    reply = ""
    for _ in range(MAX_ROUNDS):
        response = chat_fn(messages, TOOLS)
        content, calls = _parts(response)
        if not calls:
            reply = content
            break
        # keep the assistant turn in the transcript, then answer each tool call
        messages.append({"role": "assistant", "content": content,
                         "tool_calls": [c if isinstance(c, dict) else c.model_dump()
                                        for c in calls]})
        for call in calls:
            name, args = _call_parts(call)
            tool = getattr(ws, name, None)
            if name not in {t["function"]["name"] for t in TOOLS} or tool is None:
                result = f"error: unknown tool '{name}'"
            else:
                try:
                    result = tool(**args)
                except (ValueError, TypeError) as e:
                    result = f"error: {e}"
            messages.append({"role": "tool", "content": result, "tool_name": name})
    else:
        reply = "I stopped after too many steps — the changes so far are listed."

    return {"reply": reply or "Done.",
            "scenario": ws.data if ws.changed else None,
            "changed": ws.changed,
            "actions": ws.actions}
