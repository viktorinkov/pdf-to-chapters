# Implementation Plan

## Goals

- Self-hosted, single-user website that converts an unstructured PDF into a bookmarked PDF named `walnut-<originalname>.pdf`.
- Output is byte-equivalent to the input except for an appended outline section.
- All inference runs locally on the user's machine.
- Mandatory preview/edit screen so users never get a silently-wrong outline.

## Non-goals (v1)

- Multi-user / multi-tenant.
- Cloud LLM fallback.
- OCR for scanned PDFs (detect, surface error, suggest `ocrmypdf`).
- Editing PDF content (only adds outline).
- Mobile UI.
- Account / login.

## Phases

### Phase 0 — Bootstrap (1 day)

- `pyproject.toml` with hatch backend, Python ≥ 3.12, deps: `fastapi`, `uvicorn[standard]`, `sse-starlette`, `python-multipart`, `httpx`, `pymupdf`, `pikepdf`, `pydantic`.
- Repo skeleton: `walnut/`, `walnut/web/`, `tests/`, `fixtures/`.
- `walnut/cli.py` entry point: pick free port, launch uvicorn, open browser.
- Health-check route `/healthz` that pings Ollama at `:11434` and reports model status.

**Exit criterion:** `uvx --from . walnut` opens a browser to a "hello" page that says "Ollama: ready" or "Ollama: not running".

### Phase 1 — PDF text extraction (1–2 days)

- `walnut/pdf.py::inspect_pdf(path)` — page count, encryption check, page labels.
- `walnut/pdf.py::extract_pages(path)` — yields `PageDigest` per page (text, spans with font/size/flags, page label).
- Image-only-page detection via text-length / page-area heuristic.
- Page-label resolution (`logical_to_physical` for printed → physical index).
- Unit tests against fixtures: clean novel PDF, textbook PDF, encrypted PDF, image-only PDF.

**Exit criterion:** Given a PDF, we produce a list of `PageDigest` objects with structural metadata.

### Phase 2 — TOC-page detector (1 day)

- `walnut/toc.py::find_toc_pages(digests)` — regex-based detection of printed TOC pages (dot-leaders, right-aligned numbers, "Contents" heading).
- `walnut/toc.py::parse_toc(toc_pages)` — produces a candidate chapter list with printed page labels.
- Test set: 5 books with explicit TOCs (novel, textbook, reference, multi-author, foreign-language).

**Exit criterion:** ≥ 80% of fixtures with printed TOCs yield a correct chapter list without LLM involvement.

### Phase 3 — LLM integration (2 days)

- `walnut/llm.py::OllamaClient` — async wrapper around `httpx.AsyncClient` for `/api/chat`, `/api/show`, `/api/pull`.
- Pydantic schemas `ChapterEntry`, `ChapterList` (`{title, page_number, level}`).
- `walnut/llm.py::detect_chapters(text_with_signals)` — single call, `format=schema`, `stream=False`.
- `walnut/llm.py::detect_chapters_windowed(...)` — sliding window with 10 k overlap for documents > 100 k tokens.
- Self-consistency wrapper (run twice with `temperature=0.3`, intersect for confidence).

**Exit criterion:** On a held-out PDF without a printed TOC, the LLM returns a non-empty, schema-valid chapter list with ≥ 70 % F1 vs. hand-labelled ground truth.

### Phase 4 — Pipeline (1 day)

- `walnut/pipeline.py::process_pdf(job, on_progress)` — orchestrates: inspect → extract → toc-detect → llm-fallback → reconcile → confidence-score.
- Stage events: `inspect`, `extract`, `toc`, `llm`, `merge`, `score`.
- `walnut/errors.py` — typed error codes (`ENCRYPTED`, `NO_TEXT`, `OLLAMA_DOWN`, `MODEL_MISSING`, `NO_CHAPTERS`, `INVALID_PDF`, `TOO_LARGE`).

**Exit criterion:** End-to-end pipeline returns a scored chapter list for any non-error PDF.

### Phase 5 — Bookmark insertion (1 day, **trust-critical**)

- `walnut/pdf.py::add_outline(input_path, chapters, output_path)` — PyMuPDF incremental-save path.
- Pikepdf fallback for repaired PDFs.
- Page-number resolution using `get_page_labels`.
- Byte-prefix verification.
- Round-trip validation: re-open with pikepdf, assert tree shape, run `qpdf --check`.

**Exit criterion:** `walnut-<name>.pdf` validated by `pikepdf.Pdf.open(...).get_warnings()` is empty AND `qpdf --check` exits 0 or 3 (warnings only) AND the first `len(input)` bytes of output equal input exactly.

### Phase 6 — HTTP API (1 day)

- `walnut/server.py` — FastAPI app with `POST /upload`, `GET /jobs/:id/events` (SSE), `GET /jobs/:id/download`, `POST /jobs/:id/confirm`, `DELETE /jobs/:id`, `GET /healthz`.
- `walnut/queue.py` — `JobManager` with single async-worker FIFO queue.
- Unit tests via `httpx.ASGITransport` (no real socket).

**Exit criterion:** End-to-end via `curl`: upload, follow SSE, confirm, download.

### Phase 7 — Frontend, base flow (1–2 days)

- `walnut/web/index.html` — Alpine.js + EventSource, four screens: idle, run, done, err.
- `walnut/web/static/style.css` — walnut palette, Inter + Fraunces + JetBrains Mono.
- Drag-and-drop, file picker, progress bar, real-time log tail.

**Exit criterion:** A non-technical user can open the browser, drop a PDF, and download `walnut-<name>.pdf` without touching the terminal.

### Phase 8 — Preview/review screen (2 days, **non-negotiable**)

- Editable chapter list: rename, ±N page nudge, delete, drag-to-reparent.
- Yellow flags for `confidence < 0.85`, red for impossible entries.
- Per-entry tooltip explaining why it was flagged.
- Thumbnail strip showing detected start page ±2 neighbours.
- "Re-detect with these as hints" button (re-runs LLM with edits as few-shot examples).
- "Skip preview" power-user setting (default off).

**Exit criterion:** User can fix the chapter list before save, and edits round-trip into the final PDF.

### Phase 9 — Quality harness (1 day)

- `walnut/eval.py` — score predictions vs. YAML ground truth.
- 10-book fixture set covering archetypes A–H (see `docs/quality-evaluation.md`).
- `walnut bench fixtures/` produces an HTML dashboard.
- Wire into CI with a regression threshold (no per-book score may drop > 0.05).

**Exit criterion:** `walnut_score ≥ 0.85` aggregate on the fixture set.

### Phase 10 — Polish (1 day)

- Error states with helpful copy.
- "Ollama not running" doctor: try to `brew services start ollama`, link to install docs.
- README with screenshots.
- Publish to PyPI.

**Exit criterion:** `uvx walnut` works from a clean Mac with only Homebrew + Ollama installed.

## Critical path

0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Phase 5 (bookmark write) and Phase 8 (preview UX) are the trust-defining steps — do not rush them.

## Effort estimate

12–14 working days for a single developer. Concurrency: Phases 1–3 can run in parallel if split between two devs.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ollama API drift | Medium | High | Pin Ollama version in `pyproject.toml` extras; CI tests against the pinned version. |
| PyMuPDF AGPL contamination if commercial | Low for v1 | Medium | Document; offer pikepdf-only build as a switch. |
| Gemma 4 hallucination on long docs | High | Medium | Phase 2 (TOC-first) + Phase 8 (preview) catch most. |
| Byte-equivalence broken by tooling | Medium | High | Phase 5 byte-prefix assertion as a unit test. |
| Cold-start latency on first job | High | Low | `OLLAMA_KEEP_ALIVE=30m`; "warming model…" copy. |
| User uploads 500 MB PDF | Low | Medium | `TOO_LARGE` cap at 200 MB (configurable). |
| Ollama on Linux/WSL has different perf | Medium | Low | Document expected ranges in README. |

## Out-of-scope additions to consider for v2

- Cloud LLM fallback toggle (Anthropic/OpenAI/local).
- OCR pre-step using `ocrmypdf` baked in.
- Batch mode (drop a folder of PDFs).
- CLI subcommand (`walnut detect file.pdf` outputs JSON, no UI).
- Plugin API for custom prompt templates.
