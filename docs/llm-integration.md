# LLM Integration

How walnut talks to the local LLM. As of April 24, 2026.

## Model: `gemma4:e4b`

- Released by Google DeepMind on **April 2, 2026**, Apache 2.0 license.
- 4.5 B effective parameters / 8 B total, 128 k context window.
- Native function-calling and JSON output.
- Supports 140+ languages — important for international books.
- Source: https://deepmind.google/models/gemma/gemma-4/

### Model variants

| Variant | Effective | Total | Context | RAM target | Use when |
|---|---|---|---|---|---|
| `gemma4:e2b`  | 2.3 B  | 5.1 B | 128 k | 8 GB  | Smoke testing only |
| **`gemma4:e4b`** | **4.5 B** | **8 B** | **128 k** | **16 GB** | **Default for walnut** |
| `gemma4:26b`  | 4 B (MoE active) | 26 B | 256 k | 32 GB+ | Long textbooks, multi-volume |
| `gemma4:31b`  | 31 B  | 31 B  | 256 k | 64 GB+ | Maximum quality |

walnut auto-detects available RAM via `psutil` and recommends the largest variant that fits. Default is `e4b`.

## Runtime: Ollama

- `brew install ollama && brew services start ollama` starts the daemon at `127.0.0.1:11434`.
- `ollama pull gemma4:e4b` downloads (≈ 9.6 GB) on first run.
- Auto-uses MLX backend on Apple Silicon — meaningful speedup over plain llama.cpp without configuration.
- Set `OLLAMA_KEEP_ALIVE=30m` so the model stays resident between requests; cold-start is otherwise 10–30 s.

### Why not llama.cpp directly, MLX-LM, or LM Studio?

- **llama.cpp direct**: more control, GBNF grammars, slightly faster raw throughput. Drop down to it only if Ollama's grammar generation has edge cases for our schema (it doesn't, for a flat list of objects).
- **MLX-LM directly**: fastest on Apple Silicon, but you have to hand-roll the structured-output grammar. Defer until perf demands it.
- **LM Studio**: GUI-first, server mode is awkward to integrate. Also has an outstanding bug (#1741) where its MLX backend fails to load Gemma 4 26B.
- **vLLM**: optimised for batched server workloads with CUDA. Overkill on macOS, no native Apple Silicon support.

## Structured output

We use Ollama's native `format` parameter with a JSON schema generated from a Pydantic model. Since Ollama 0.5, the schema is compiled to a llama.cpp GBNF grammar that constrains the sampler — invalid tokens are masked at every step, so the output is **guaranteed valid JSON matching the schema** before validation runs. Zero retries needed.

### Pydantic schema

```python
from pydantic import BaseModel, Field
from typing import Literal

class ChapterEntry(BaseModel):
    title: str = Field(description="Chapter or section title as printed in the book")
    page_number: int = Field(description="Printed page label (NOT physical index) where the chapter starts", ge=1)
    level: Literal[1, 2, 3] = Field(
        description="1 = chapter or part, 2 = section, 3 = sub-section"
    )

class ChapterList(BaseModel):
    chapters: list[ChapterEntry]
```

### Calling Ollama

```python
import httpx
import json
from .schemas import ChapterList

async def detect_chapters(prompt: str, *, model: str = "gemma4:e4b") -> ChapterList:
    async with httpx.AsyncClient(timeout=600.0) as client:
        r = await client.post(
            "http://127.0.0.1:11434/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user",   "content": prompt},
                ],
                "format": ChapterList.model_json_schema(),
                "stream": False,
                "options": {
                    "temperature": 0.2,
                    "top_p": 0.95,
                    "num_ctx": 131072,
                },
            },
        )
        r.raise_for_status()
        body = r.json()
        return ChapterList.model_validate_json(body["message"]["content"])
```

We use `httpx` rather than the `ollama` Python SDK because:
- We're already using `httpx.AsyncClient` for everything else.
- The SDK adds a layer that doesn't help us; the API is just one POST.
- We can swap to a different LLM provider with minimal change.

## Context-window strategy

A 300-page novel is ~75 k tokens. A textbook can hit 200 k+. Strategy:

1. **TOC-first** (`docs/pdf-processing.md` covers this). When a printed TOC is found, the LLM only sees the TOC pages (~3 k tokens) and just normalizes them — virtually no hallucination risk.
2. **Constrained candidate-pages** (when no TOC). Pre-filter pages where a top-half line has font ≥ p95. Send only those (~10–15 % of the doc) with surrounding context. Cuts cost by 10× and eliminates "creative" hallucinations on boring middle pages.
3. **Sliding window** for the rare > 100 k token cases. Window of ~80 k tokens with 10 k overlap, prepending each chunk with `### START_PAGE=<n>` anchors so the model can ground page references. Merge candidates by `(title, page_number)` proximity (titles within 5 pages and >0.85 string similarity collapse).
4. **Self-consistency** at the end. Re-run with the same prompt at `temperature=0.3`. Intersect the two outputs → high-confidence set. Symmetric difference → yellow-flagged for preview.

## System prompt

See `prompts.md` for the full text. Highlights:

- "Use the source language of the heading; do not translate."
- "A chapter must have a heading-style line (font ≥ p90 of document)."
- "If a line looks like a section number (e.g., '3.1') nest it under the matching chapter."
- "Return [] if nothing chapter-like is found."

## Hardware expectations

| Mac | RAM | Recommended | tok/s | Latency (TOC-parse, ~5 k tokens out) |
|---|---|---|---|---|
| MacBook Air M2/M3 | 16 GB | `gemma4:e4b` (Q8) | 18–24 | ~5 s |
| MacBook Pro M3 Max | 36 GB | `gemma4:26b` (Q4) | 14–18 | ~6 s |
| Mac Studio M3 Max | 48 GB | `gemma4:31b` (Q5) | 16–20 | ~8 s |
| Mac Studio M4 Max | 64 GB | `gemma4:31b` (Q8) | 20–26 | ~6 s |
| M2/M4 Ultra | 128 GB+ | `gemma4:31b` (BF16) | 12–16 | ~10 s |

**End-to-end on a 300-page PDF:**
- TOC-first path (succeeds in ~80 % of trade books): 5–10 s on 32 GB Mac.
- Full-text fallback (3–4 windows): 60–90 s on 32 GB Mac.
- Worst case (31B, full-text): 2–3 min.

## Risks and fallbacks

1. **Hallucinated chapters / page numbers.** Validate `page_number ∈ [1, page_count]` AND that ≥ 1 word of the title appears in the actual page text within ±2 pages. Drop entries that fail. (Done in `confidence.py`.)
2. **Scanned/image-only PDFs.** Detect early in `inspect_pdf`. Don't run the LLM. Surface `NO_TEXT` and suggest `ocrmypdf input.pdf input_ocr.pdf --skip-text`.
3. **Non-English documents.** Gemma 4 supports 140+ languages. Add a system note: `"The document may be in any language. Preserve titles in their original script."`
4. **Very long documents (> 500 pages).** Even 256 k context isn't enough sometimes. Fall back to embedding-based segmentation (sentence-transformers MiniLM on CPU) to find structural shifts, then run LLM only on candidate boundary pages.
5. **Ollama `format=` + thinking models silent failure** (issue #15260). Mitigation: pin Ollama version, unit-test JSON-schema conformance on every release, validate output with `model_validate_json` and retry once on parse failure.
6. **Cold start.** Set `OLLAMA_KEEP_ALIVE=30m`; show "warming model…" during first inference of a session.
7. **Network calls under enterprise proxies.** Ollama is localhost only — no proxy hop needed. Document explicitly so users on managed Macs aren't confused.

## Sources

- https://deepmind.google/models/gemma/gemma-4/
- https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/
- https://docs.ollama.com/capabilities/structured-outputs
- https://github.com/ollama/ollama/issues/15260
- https://huggingface.co/blog/gemma4
