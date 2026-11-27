"""Corpus index for the Alteran voice agent.

Reads the site's own sources — published articles, entity definitions, taxonomy —
and builds a BM25 index. No embeddings, no cloud: retrieval runs on this machine,
over the same files the website is built from. The structure is auditable.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from rank_bm25 import BM25Okapi

SITE = "https://alteranai.com"
# The voice app normally lives inside the AlteranAI site repo (voice/). Allow
# overriding the site root via env so it can run standalone.
_here = Path(__file__).resolve().parent
if os.environ.get("ALTERAN_REPO"):
    REPO = Path(os.environ["ALTERAN_REPO"])
elif (_here / "src").is_dir():
    REPO = _here
elif (_here.parent / "src").is_dir():
    REPO = _here.parent
else:
    REPO = _here.parent
ARTICLES = REPO / "src" / "content" / "articles"
ENTITIES_TS = REPO / "src" / "data" / "entities.ts"
SITE_TS = REPO / "src" / "data" / "site.ts"

TOKEN = re.compile(r"[\w]+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    return TOKEN.findall(text.lower())


@dataclass
class Chunk:
    text: str
    title: str
    url: str
    kind: str  # article | entity | taxonomy | fact
    heading: str = ""
    score: float = field(default=0.0)


def _frontmatter(raw: str) -> tuple[dict, str]:
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end != -1:
            meta = yaml.safe_load(raw[3:end]) or {}
            body = raw[end + 4:].lstrip("\n")
            return meta, body
    return {}, raw


def _clean(body: str) -> str:
    body = re.sub(r"\[@[^\]]+\]", "", body)          # citation markers
    body = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", body)  # images
    body = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", body)  # links -> text
    return body.strip()


def _sections(body: str) -> list[tuple[str, str]]:
    """Split markdown into (heading, text) sections; paragraphs merged to ~1200 chars."""
    parts = re.split(r"^(#{1,3} .+)$", body, flags=re.MULTILINE)
    out: list[tuple[str, str]] = []
    heading = ""
    buf = ""
    for part in parts:
        if re.match(r"^#{1,3} ", part):
            if buf.strip():
                out.append((heading, buf.strip()))
            heading, buf = part.lstrip("# ").strip(), ""
        else:
            buf += part
    if buf.strip():
        out.append((heading, buf.strip()))
    # merge tiny sections, split huge ones on paragraphs
    merged: list[tuple[str, str]] = []
    for h, t in out:
        if len(t) > 1600:
            paras, cur = t.split("\n\n"), ""
            for p in paras:
                if len(cur) + len(p) > 1300 and cur:
                    merged.append((h, cur.strip()))
                    cur = p
                else:
                    cur += "\n\n" + p
            if cur.strip():
                merged.append((h, cur.strip()))
        else:
            merged.append((h, t))
    return merged


def _article_chunks() -> list[Chunk]:
    chunks: list[Chunk] = []
    if not ARTICLES.is_dir():
        return chunks
    for path in sorted(ARTICLES.glob("*.md")):
        meta, body = _frontmatter(path.read_text(encoding="utf-8"))
        if meta.get("status", "draft") != "published":
            continue
        title = meta.get("title", path.stem)
        slug = path.stem
        url = f"{SITE}/articles/{slug}/"
        desc = meta.get("description", "")
        topics = ", ".join(meta.get("topics", []) or [])
        chunks.append(Chunk(
            text=f"{title}. {desc} Topics: {topics}.",
            title=title, url=url, kind="article", heading="overview",
        ))
        for heading, text in _sections(_clean(body)):
            text = text.strip()
            if len(text) < 40:
                continue
            chunks.append(Chunk(
                text=f"{title} — {heading}: {text}" if heading else f"{title}: {text}",
                title=title, url=url, kind="article", heading=heading,
            ))
    return chunks


def _entity_chunks() -> list[Chunk]:
    chunks: list[Chunk] = []
    if not ENTITIES_TS.is_file():
        return chunks
    src = ENTITIES_TS.read_text(encoding="utf-8")
    for kind, block in (("tool", "TOOLS"), ("concept", "CONCEPTS")):
        m = re.search(rf"export const {block}: Entity\[\] = \[(.*?)\n\];", src, re.DOTALL)
        if not m:
            continue
        for entry in re.finditer(
            r"\{\s*slug:\s*'([^']+)',\s*name:\s*'([^']+)',(.*?)line:\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")",
            m.group(1), re.DOTALL,
        ):
            slug, name = entry.group(1), entry.group(2)
            line = (entry.group(4) or entry.group(5) or "").replace("\\'", "'").replace('\\"', '"')
            own = "own: true" in entry.group(3)
            label = "Alteran concept" if own else kind
            chunks.append(Chunk(
                text=f"{name} ({label}): {line}",
                title=name, url=f"{SITE}/{kind}/{slug}/", kind="entity",
            ))
    return chunks


def _taxonomy_chunks() -> list[Chunk]:
    chunks: list[Chunk] = []
    if not SITE_TS.is_file():
        return chunks
    src = SITE_TS.read_text(encoding="utf-8")
    for block, kind, base in (("categories", "category", "categories"), ("clusters", "cluster", "clusters")):
        m = re.search(rf"export const {block} = \[(.*?)\] as const;", src, re.DOTALL)
        if not m:
            continue
        for entry in re.finditer(r"slug:\s*'([^']+)',\s*name:\s*'([^']+)',[^}]*?line:\s*'((?:[^'\\]|\\.)*)'", m.group(1)):
            slug, name, line = entry.groups()
            chunks.append(Chunk(
                text=f"{name} ({kind} on AlteranAI): {line}",
                title=name, url=f"{SITE}/{base}/", kind="taxonomy",
            ))
    return chunks


# Hand-extracted from src/pages/about.astro and index.astro — the agent's core identity facts.
FACTS = [
    ("AlteranAI", "AlteranAI (alteranai.com) is the engineering notebook and philosophy site of Michal Malček, an AI engineer with 20 years across software delivery. It is written from inside Factorium: five AI seats and one human working on one machine. The models draft and measure; a human decides and signs off. Every figure on the site has a path back to its source; a figure that could not be verified is not published."),
    ("Alteran vs Mecha", "Two engineering trajectories for AI. Mecha: models in brittle prompt cages, hardened by defensive training, deployed to automate noise. Alteran: models bound to explicit, auditable, machine-readable structure anyone can inspect. The boundary claim: Mecha must not dominate, destroy, or prevent Alterity. Not anti-automation, not a safety pitch — auditable structure is cheaper, not just safer. Article: Alterans and Mechas."),
    ("Measured figures", "From the running system, measured 22 October 2026: tool success 93.9% over 1,352 real calls; about $30/month for 15 users; longest unattended run 120 turns over 67 minutes; zero reasoning failures in 477 logged calls; 64,644 lines of TypeScript on 29 runtime dependencies; rule retrieval 10 out of 10, up from 1 in 5."),
    ("The hive (Factorium)", "Five seats and one human. Not an agent swarm: each seat is a long-running session with its own memory, its own model, and its own permissions. Prime is the architecture seat running Claude Code; other seats run in Cursor. Una is the local sovereign agent: gemma-4-12b-it at Q5_K_M on llama.cpp, 131,072-token context, running unattended on one machine with 24 GB RAM."),
    ("The offer", "Michal Malček builds custom AI systems (sovereign, cloud, or both), gives consultations (architecture reviews, retrieval audits, cost and model-routing decisions measured on your own data) and workshops (working with Claude Code and local models). Open to employment as well as projects. Contact through the CV at misomalcek.github.io/cyber-cv/."),
    ("Retrieval stack", "The hive's retrieval: pgvector, Qdrant, Apache AGE; hand-written lexical and vector fusion (RRF), cross-encoder reranking, graph expansion, provenance tiers. All embeddings are 1024-dimensional bge-m3 vectors. Search is retrosynthesis: parallel search pays off on breadth, about 15x the tokens of a chat."),
    ("Site structure", "The site has four nodes: .com (about Michal), articles (engineering notes), topics (the research corpus taxonomy), and a glossary of tools and concepts. Categories: Engineering, Practice, Research (Axis I); Philosophy, Nature (Axis II). Clusters include retrieval-that-works, memory-architecture, failure-modes, sovereign-inference, multi-agent-not-a-swarm, phyto, natural-flow, the-dispozitiv."),
    ("This voice agent", "You are speaking with the Alteran voice agent: a free-tier pipeline. Speech-to-text: Groq whisper-large-v3-turbo. Reasoning: Groq gpt-oss-120b with an OpenRouter free fallback. Speech: Groq Orpheus, with free fallbacks. Retrieval: BM25 over the site's own published articles and glossary, running locally. No Cloudflare call in the loop for this version."),
]


def _fact_chunks() -> list[Chunk]:
    return [Chunk(text=f"{t}: {b}", title=t, url=SITE, kind="fact") for t, b in FACTS]


class Corpus:
    def __init__(self) -> None:
        self.chunks: list[Chunk] = (
            _article_chunks() + _entity_chunks() + _taxonomy_chunks() + _fact_chunks()
        )
        self.bm25 = BM25Okapi([tokenize(c.text) for c in self.chunks])
        self.articles = len({c.url for c in self.chunks if c.kind == "article"})

    def search(self, query: str, k: int = 5) -> list[Chunk]:
        scores = self.bm25.get_scores(tokenize(query))
        order = sorted(range(len(scores)), key=lambda i: -scores[i])[:k]
        out = []
        for i in order:
            if scores[i] <= 0:
                continue
            c = self.chunks[i]
            c.score = float(scores[i])
            out.append(c)
        return out

    def stats(self) -> dict:
        kinds: dict[str, int] = {}
        for c in self.chunks:
            kinds[c.kind] = kinds.get(c.kind, 0) + 1
        return {"articles": self.articles, "chunks": len(self.chunks), "by_kind": kinds}


if __name__ == "__main__":
    import sys
    corpus = Corpus()
    print(json.dumps(corpus.stats(), indent=2))
    q = " ".join(sys.argv[1:]) or "what is the difference between alteran and mecha"
    for c in corpus.search(q):
        print(f"\n[{c.score:.1f}] {c.title} ({c.kind}) {c.url}\n  {c.text[:220]}")