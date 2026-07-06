"""Chat-with-doc (RAG): retrieval picks the right blocks, answers carry cited
sources, and everything degrades cleanly without Ollama (all tests use fakes)."""
import io

import pytest

import doc_chat


BLOCKS = [
    {"index": 0, "section_path": ["4 Brakes"], "text": "The brake system shall stop the vehicle."},
    {"index": 1, "section_path": ["5 Battery"], "text": "The battery pack stores traction energy."},
    {"index": 2, "section_path": [], "text": "This document is synthetic."},
]


def fake_embed(texts):
    # A deterministic stand-in: one dimension per topic keyword.
    return [[t.lower().count("brake"), t.lower().count("battery"), 1.0] for t in texts]


@pytest.fixture(autouse=True)
def fresh_store():
    doc_chat.clear()
    yield
    doc_chat.clear()


def test_ask_retrieves_the_right_block_and_cites_it():
    doc_chat.index_document(BLOCKS, "spec.docx")
    seen = {}

    def fake_chat(question, excerpts):
        seen["excerpts"] = excerpts
        return "The brakes stop the vehicle [1]."

    res = doc_chat.ask_document("how does the brake work?", k=2,
                                embed_fn=fake_embed, chat_fn=fake_chat)
    assert res["answer"].endswith("[1].")
    # the brake block must be the top source, with its breadcrumb
    assert res["sources"][0]["block"] == 0
    assert res["sources"][0]["section"] == "4 Brakes"
    assert "[1] (4 Brakes)" in seen["excerpts"]
    assert res["document"] == "spec.docx"
    assert len(res["sources"]) == 2


def test_block_vectors_are_embedded_once():
    doc_chat.index_document(BLOCKS, "spec.docx")
    calls = []

    def counting_embed(texts):
        calls.append(len(texts))
        return fake_embed(texts)

    doc_chat.ask_document("brakes?", embed_fn=counting_embed, chat_fn=lambda q, e: "x")
    doc_chat.ask_document("battery?", embed_fn=counting_embed, chat_fn=lambda q, e: "x")
    # first ask embeds all blocks + the question; the second only the question
    assert calls == [len(BLOCKS), 1, 1]


def test_duplicate_texts_are_not_retrieved_twice():
    # A schedule table repeats short cells ("Pre-sleep") — retrieval must not
    # spend its k slots on copies of the same text.
    dupes = [
        {"index": 0, "section_path": ["Day 1"], "text": "Brake"},
        {"index": 1, "section_path": ["Day 2"], "text": "Brake"},
        {"index": 2, "section_path": ["Day 3"], "text": "brake"},
        {"index": 3, "section_path": ["Rules"], "text": "The brake rule text."},
    ]
    doc_chat.index_document(dupes, "d.docx")
    res = doc_chat.ask_document("brake?", k=2, embed_fn=fake_embed, chat_fn=lambda q, e: "x")
    texts = [s["text"].lower() for s in res["sources"]]
    assert len(texts) == 2 and len(set(texts)) == 2


def test_no_document_is_a_clean_error():
    with pytest.raises(LookupError, match="Import doc"):
        doc_chat.ask_document("anything", embed_fn=fake_embed, chat_fn=lambda q, e: "x")


def test_extract_route_indexes_the_document(client, sample_docx_bytes):
    doc_chat.clear()
    r = client.post("/extract", data={"document": (io.BytesIO(sample_docx_bytes), "spec.docx")})
    assert r.status_code == 200
    assert doc_chat.has_document()
    assert doc_chat.document_name() == "spec.docx"


def test_doc_chat_route_happy(client, monkeypatch):
    doc_chat.index_document(BLOCKS, "spec.docx")
    monkeypatch.setattr(doc_chat, "_embed", fake_embed)
    monkeypatch.setattr(doc_chat, "_chat", lambda q, e: "Answer [1].")
    r = client.post("/doc_chat", json={"question": "brakes?"})
    assert r.status_code == 200
    data = r.get_json()
    assert data["answer"] == "Answer [1]."
    assert data["sources"]


def test_doc_chat_route_errors(client, monkeypatch):
    r = client.post("/doc_chat", json={"question": ""})
    assert r.status_code == 400          # empty question

    doc_chat.clear()
    r = client.post("/doc_chat", json={"question": "hi"})
    assert r.status_code == 400          # nothing imported yet
    assert "Import doc" in r.get_json()["error"]

    # Ollama down -> 503, same shape as /parse
    doc_chat.index_document(BLOCKS, "spec.docx")

    def down(texts):
        raise RuntimeError("Could not reach local Ollama embedding model")
    monkeypatch.setattr(doc_chat, "_embed", down)
    r = client.post("/doc_chat", json={"question": "hi"})
    assert r.status_code == 503
    assert "Ollama" in r.get_json()["error"]
