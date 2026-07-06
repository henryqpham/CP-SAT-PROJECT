"""Flask endpoints through the test client — no live server, no Ollama."""
import io


# --------------------------------------------------------------------------- #
# Static pages + examples.
# --------------------------------------------------------------------------- #
def test_index_serves_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.content_type


def test_examples_list(client):
    r = client.get("/examples")
    assert r.status_code == 200
    names = [e["name"] for e in r.get_json()]
    assert "lake" in names


def test_example_lake(client):
    r = client.get("/example/lake")
    assert r.status_code == 200
    assert r.get_json()["activities"]


def test_example_unknown_404(client):
    r = client.get("/example/nope")
    assert r.status_code == 404
    assert "error" in r.get_json()


def test_example_bad_name_400(client):
    r = client.get("/example/BAD..NAME")
    assert r.status_code == 400
    assert "error" in r.get_json()


# --------------------------------------------------------------------------- #
# /solve
# --------------------------------------------------------------------------- #
def test_solve_lake_optimal(client, lake):
    r = client.post("/solve", json=lake.model_dump())
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "OPTIMAL"
    assert body["schedule"]
    assert body["horizon"] == 1440


def test_solve_garbage_400(client):
    r = client.post("/solve", json={"activities": "x"})
    assert r.status_code == 400
    body = r.get_json()
    assert body["error"]
    assert body["details"]  # per-field {loc, message} pairs


def test_solve_no_body_400(client):
    r = client.post("/solve")
    assert r.status_code == 400
    assert "error" in r.get_json()


# --------------------------------------------------------------------------- #
# /explain and /relax on the over-constrained lake plan.
# --------------------------------------------------------------------------- #
def test_explain_lake_infeasible(client, lake_infeasible):
    r = client.post("/explain", json=lake_infeasible.model_dump())
    assert r.status_code == 200
    body = r.get_json()
    assert body["structural"] is False
    assert sorted(body["conflict_ids"]) == ["c1", "c3"]


def test_relax_lake_infeasible(client, lake_infeasible):
    # Every lake rule defaults to priority 1 (hard), so nothing is droppable:
    # relax reports the hard conflict instead of solving.
    r = client.post("/relax", json=lake_infeasible.model_dump())
    assert r.status_code == 200
    body = r.get_json()
    assert body["solved"] is False
    assert body["dropped"] == []
    assert body["structural"] is False
    assert sorted(body["hard_conflict"]) == ["c1", "c3"]


# --------------------------------------------------------------------------- #
# /extract — the .docx upload path.
# --------------------------------------------------------------------------- #
def test_extract_docx_without_llm(client, sample_docx_bytes, monkeypatch):
    # Trip any model use. extract_document binds _ask_json as a default arg,
    # so also patch ollama.chat (the real call boundary) underneath it.
    import extract
    import ollama

    def boom(*args, **kwargs):
        raise AssertionError("the local model was called")

    monkeypatch.setattr(extract, "_ask_json", boom)
    monkeypatch.setattr(ollama, "chat", boom)

    r = client.post(
        "/extract",
        data={"document": (io.BytesIO(sample_docx_bytes), "sample.docx")},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["scenario"]["activities"]
    assert body["coverage"]["n_activities"] == 29
    assert body["coverage"]["extraction"]["llm_calls"] == 0
    assert body["warnings"]
    # a swallowed model failure would leave this warning; there is none
    assert not any("residual model call" in w for w in body["warnings"])


def test_extract_no_file_400(client):
    r = client.post("/extract", data={})
    assert r.status_code == 400
    assert "error" in r.get_json()


def test_extract_pdf_400(client):
    r = client.post("/extract", data={"document": (io.BytesIO(b"%PDF-1.4"), "spec.pdf")})
    assert r.status_code == 400
    assert ".docx" in r.get_json()["error"]


def test_extract_corrupt_docx_400(client):
    # Garbage bytes named .docx get the clean 400 (extract_blocks raises ValueError).
    r = client.post("/extract", data={"document": (io.BytesIO(b"not a real docx"), "x.docx")})
    assert r.status_code == 400
    assert "Couldn't read that document" in r.get_json()["error"]
