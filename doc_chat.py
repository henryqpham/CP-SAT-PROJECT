"""Chat with the ingested document — the one RAG feature.

After a .docx import, its blocks (with their section breadcrumbs) stay in memory
here. A question is answered by: embed the blocks once (lazily), embed the
question, cosine top-k retrieve, then ask the local chat model to answer FROM
those excerpts with a [n] citation on every claim. The retrieved blocks are
always returned as `sources`, so the answer can be checked against the document.

Extraction is NOT this: /extract stays a full deterministic sweep over every
block (top-k retrieval could drop a buried requirement). This module is only
for asking questions afterwards.

Everything is local Ollama (models named by env vars, never hardcoded). If
Ollama is down this degrades exactly like /parse: a clean error, app still fine.
"""
import math
import os

import ollama

from parse import MODEL  # the chat model (OLLAMA_MODEL)

# The embedding model, separate from the chat model. Override via env.
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")

TOP_K = 6
SNIPPET_CHARS = 500  # what we show back as a source snippet
# Bound the index: caps the first-question embed time, the vector memory, and the
# per-question cosine scan all at once (a huge doc keeps its first blocks).
MAX_CHAT_BLOCKS = int(os.environ.get("DOC_CHAT_MAX_BLOCKS", "5000"))
EMBED_BATCH = 128  # texts per ollama.embed call, so no single request grinds

_SYSTEM = """You answer questions about ONE document, using ONLY the numbered excerpts given.
Rules:
- Cite the excerpt number for every claim, like [2]. Every sentence needs at least one citation.
- If the excerpts don't contain the answer, say you can't find it in the document.
- Be brief and factual. Never invent content that isn't in an excerpt.
"""

# The last ingested document, held in memory only (nothing is written to disk).
# {"name": str, "blocks": [...], "vectors": [[float]] or None (embedded lazily)}
_store = None


def index_document(blocks: list[dict], name: str = "document"):
    """Remember the just-ingested blocks so /doc_chat can answer about them.
    Embedding happens lazily on the first question (imports stay fast)."""
    global _store
    truncated = len(blocks) > MAX_CHAT_BLOCKS
    _store = {"name": name, "blocks": blocks[:MAX_CHAT_BLOCKS], "vectors": None,
              "truncated": truncated}


def has_document() -> bool:
    return _store is not None


def document_name() -> str:
    return _store["name"] if _store else ""


def clear():
    global _store
    _store = None


def _block_text(b: dict) -> str:
    # Prefix the breadcrumb so "which day / which section" questions retrieve well.
    crumb = " > ".join(b.get("section_path", []))
    return f"({crumb}) {b['text']}" if crumb else b["text"]


def _embed(texts: list[str]) -> list[list[float]]:
    """Local Ollama embeddings for a list of texts (sent in batches). Raises
    RuntimeError when Ollama is down or the model isn't pulled (-> a clean 503)."""
    vectors: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        try:
            res = ollama.embed(model=EMBED_MODEL, input=texts[i:i + EMBED_BATCH])
        except Exception as e:
            raise RuntimeError(
                f"Could not reach local Ollama embedding model '{EMBED_MODEL}'. Is Ollama "
                f"running and the model pulled (`ollama pull {EMBED_MODEL}`)? Original error: {e}"
            )
        vectors.extend(res["embeddings"])
    return vectors


def _chat(question: str, excerpts: str) -> str:
    try:
        msg = ollama.chat(
            model=MODEL,
            messages=[{"role": "system", "content": _SYSTEM},
                      {"role": "user", "content": f"Excerpts:\n{excerpts}\n\nQuestion: {question}"}],
            options={"temperature": 0, "num_predict": 1024, "num_ctx": 16384},
        )
    except Exception as e:
        raise RuntimeError(
            f"Could not reach local Ollama model '{MODEL}'. Is Ollama running and the "
            f"model pulled (`ollama pull {MODEL}`)? Original error: {e}"
        )
    return msg.message.content.strip()


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def ask_document(question: str, k: int = TOP_K, embed_fn=None, chat_fn=None) -> dict:
    """Answer a question about the ingested document, with cited sources.

    `embed_fn(texts)->vectors` and `chat_fn(question, excerpts)->answer` are
    injectable so the whole path is testable without Ollama.
    Raises LookupError when no document was ingested; RuntimeError when the
    local models can't be reached.
    """
    if _store is None:
        raise LookupError("No document has been imported yet — use Import doc first.")
    embed_fn = embed_fn or _embed
    chat_fn = chat_fn or _chat

    blocks = _store["blocks"]
    if _store["vectors"] is None:
        _store["vectors"] = embed_fn([_block_text(b) for b in blocks])

    qvec = embed_fn([question])[0]
    scored = sorted(((_cosine(qvec, v), i) for i, v in enumerate(_store["vectors"])),
                    reverse=True)
    # Take the best k DISTINCT texts. A schedule table repeats short cells ("Pre-sleep")
    # across days; without this they crowd out the actual rule statements.
    top, seen = [], set()
    for _score, i in scored:
        text = blocks[i]["text"].strip().lower()
        if text in seen:
            continue
        seen.add(text)
        top.append(i)
        if len(top) >= max(1, k):
            break

    excerpts = "\n".join(
        f"[{n + 1}] {_block_text(blocks[i])[:SNIPPET_CHARS]}" for n, i in enumerate(top))
    answer = chat_fn(question, excerpts)

    return {
        "answer": answer,
        "sources": [{
            "n": n + 1,
            "block": blocks[i]["index"],
            "section": " > ".join(blocks[i].get("section_path", [])),
            "text": blocks[i]["text"][:SNIPPET_CHARS],
        } for n, i in enumerate(top)],
        "document": _store["name"],
        "model": MODEL,
        "embed_model": EMBED_MODEL,
    }
