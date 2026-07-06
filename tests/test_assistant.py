"""The plan assistant: typed tools, IR validation on every change, and the
tool-calling loop — all with a scripted fake model (no Ollama)."""
import pytest

import assistant
from assistant import assist
from conftest import load_example


def scripted(*rounds):
    """A fake chat model that plays back the given responses in order and
    records every messages list it was called with."""
    calls = {"messages": []}

    def chat_fn(messages, tools):
        calls["messages"].append([dict(m) for m in messages])
        i = len(calls["messages"]) - 1
        return rounds[min(i, len(rounds) - 1)]

    chat_fn.calls = calls
    return chat_fn


def tool_call(name, **args):
    return {"message": {"content": "", "tool_calls": [
        {"function": {"name": name, "arguments": args}}]}}


def final(text):
    return {"message": {"content": text, "tool_calls": []}}


def test_add_activity_and_reply(lake):
    fn = scripted(
        tool_call("add_activity", id="swim", duration=45, section="Lake"),
        final("Added a 45 minute swim."),
    )
    res = assist("add a 45 min swim at the lake", lake, chat_fn=fn)
    assert res["changed"] is True
    ids = {a["id"] for a in res["scenario"]["activities"]}
    assert "swim" in ids
    new = next(a for a in res["scenario"]["activities"] if a["id"] == "swim")
    assert (new["duration"], new["section"]) == (45, "Lake")
    assert res["actions"] == ["added activity swim (45m, section Lake)"]
    assert res["reply"] == "Added a 45 minute swim."


def test_set_duration_and_toggle(lake):
    first_con = lake.constraints[0].id
    fn = scripted(
        tool_call("set_duration", id="sail", duration=60),
        tool_call("toggle_constraint", id=first_con, enabled=False),
        final("Done."),
    )
    res = assist("shorten sailing and drop the first rule", lake, chat_fn=fn)
    sail = next(a for a in res["scenario"]["activities"] if a["id"] == "sail")
    assert sail["duration"] == 60
    con = next(c for c in res["scenario"]["constraints"] if c["id"] == first_con)
    assert con["enabled"] is False
    assert len(res["actions"]) == 2


def test_unknown_id_bounces_back_as_tool_error(lake):
    fn = scripted(
        tool_call("set_duration", id="nope", duration=10),
        final("There is no activity called nope."),
    )
    res = assist("shorten nope", lake, chat_fn=fn)
    assert res["changed"] is False and res["scenario"] is None
    # the error went back to the model as a tool message
    tool_msgs = [m for m in fn.calls["messages"][1] if m.get("role") == "tool"]
    assert tool_msgs and "no activity with id 'nope'" in tool_msgs[0]["content"]


def test_invalid_constraint_is_rejected_by_the_ir(lake):
    fn = scripted(
        tool_call("add_constraint", constraint={"type": "time_lag", "from_id": "sail",
                                                "to_id": "hamburger"}),  # no min/max lag
        final("That rule was invalid."),
    )
    res = assist("add a lag rule", lake, chat_fn=fn)
    assert res["changed"] is False
    tool_msgs = [m for m in fn.calls["messages"][1] if m.get("role") == "tool"]
    assert "error" in tool_msgs[0]["content"]
    assert "min_lag" in tool_msgs[0]["content"]


def test_solve_tool_reports_status(lake):
    fn = scripted(
        tool_call("solve"),
        final("It fits."),
    )
    assist("does it fit?", lake, chat_fn=fn)
    tool_msgs = [m for m in fn.calls["messages"][1] if m.get("role") == "tool"]
    assert "OPTIMAL" in tool_msgs[0]["content"]


def test_explain_tool_names_the_conflict(lake_infeasible):
    fn = scripted(
        tool_call("explain_infeasible"),
        final("Two rules clash."),
    )
    assist("why is it red?", lake_infeasible, chat_fn=fn)
    tool_msgs = [m for m in fn.calls["messages"][1] if m.get("role") == "tool"]
    assert "conflicting rules:" in tool_msgs[0]["content"]


def test_unknown_tool_is_refused(lake):
    fn = scripted(
        tool_call("rm_rf", path="/"),
        final("Sorry."),
    )
    res = assist("do something weird", lake, chat_fn=fn)
    assert res["changed"] is False
    tool_msgs = [m for m in fn.calls["messages"][1] if m.get("role") == "tool"]
    assert "unknown tool" in tool_msgs[0]["content"]


def test_runaway_loop_is_capped(lake):
    fn = scripted(tool_call("solve"))  # never returns a final answer
    res = assist("loop forever", lake, chat_fn=fn)
    assert "stopped" in res["reply"]
    assert len(fn.calls["messages"]) == assistant.MAX_ROUNDS


def test_assist_route(client, monkeypatch, lake):
    def fake_chat(messages, tools):
        return final("Nothing to do.")
    monkeypatch.setattr(assistant, "_ollama_chat", fake_chat)
    r = client.post("/assist", json={"message": "hello", "scenario": lake.model_dump()})
    assert r.status_code == 200
    assert r.get_json()["reply"] == "Nothing to do."

    r = client.post("/assist", json={"message": "", "scenario": lake.model_dump()})
    assert r.status_code == 400
    r = client.post("/assist", json={"message": "hi", "scenario": {"activities": "x"}})
    assert r.status_code == 400

    def down(messages, tools):
        raise RuntimeError("Could not reach local Ollama model")
    monkeypatch.setattr(assistant, "_ollama_chat", down)
    r = client.post("/assist", json={"message": "hi", "scenario": lake.model_dump()})
    assert r.status_code == 503
