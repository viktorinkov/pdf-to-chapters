# Architecture

Single-process, local-only HTTP service that orchestrates a local LLM (Ollama) and PDF tooling (PyMuPDF + pikepdf). The browser, backend, and Ollama all run on the user's machine.

## Component diagram

```
+-----------------------------+        +--------------------------------------+
|  Browser (UI)               |        |  walnut backend (Python, FastAPI)    |
|                             |        |                                      |
|  vanilla HTML + Alpine.js   | <----> |  routes:                             |
|  EventSource for progress   |  HTTP  |    POST /upload                      |
|  drag-and-drop upload       |        |    GET  /jobs/:id/events  (SSE)      |
|  preview/edit screen        |        |    POST /jobs/:id/confirm            |
|                             |        |    GET  /jobs/:id/download           |
|                             |        |    DEL  /jobs/:id                    |
|                             |        |    GET  /healthz                     |
|                             |        |  in-memory FIFO job queue            |
|                             |        |  one async worker task               |
+-----------------------------+        +-----+----------------+---------------+
                                             |                |
                                             v                v
                              +--------------+--+    +--------+--------------+
                              | PyMuPDF + pikepdf|   | Ollama HTTP            |
                              | text extraction  |   | http://localhost:11434 |
                              | outline write    |   | gemma4:e4b             |
                              | byte-preserving  |   | structured JSON output |
                              +------------------+   +------------------------+
```

Everything binds to `127.0.0.1`. No outbound network calls except to Ollama. CORS allowlist: `http://localhost:*`, `http://127.0.0.1:*`.

## Request flow (happy path)

1. **Upload** — Browser POSTs `multipart/form-data` to `/upload`. Server streams the file to `/tmp/walnut/<job_id>/in.pdf` in 1 MiB chunks. Returns `{job_id, page_count, size_bytes}`.
2. **Subscribe** — Browser opens `EventSource('/jobs/<id>/events')`. Server registers a fan-out queue.
3. **Process** (worker task):
   1. `inspect_pdf` — page count, encryption, page labels. Emits `stage: inspect`.
   2. `extract_pages` — text + spans with font/size/flags per page. Emits `stage: extract` with `{page, total}`.
   3. `find_toc_pages` — printed TOC detection. Emits `stage: toc`.
   4. If TOC found: `parse_toc`. Else: `detect_chapters_llm` (windowed if needed). Emits `stage: llm` with `{tokens_in}`.
   5. `score_confidence` — fuse logprobs + agreement + heuristics. Emits `stage: score`.
4. **Preview** — Server emits `event: preview` with `{chapters: [...]}`. Browser switches to preview screen and waits for user confirmation. Browser POSTs the (possibly edited) chapter list to `/jobs/<id>/confirm`.
5. **Write** — `add_outline(in.pdf, chapters, walnut-<name>.pdf)` using PyMuPDF incremental save. Emits `stage: write`.
6. **Verify** — byte-prefix assertion + `pikepdf.Pdf.open(...).get_warnings()` empty + `qpdf --check` returns 0 or 3. Emits `event: complete` with `{download_url, chapters}`.
7. **Download** — Browser GETs `/jobs/<id>/download`. Server returns `application/pdf` with `Content-Disposition: attachment; filename="walnut-<name>.pdf"`.

## Failure flow

Any stage may emit `event: error` with a typed code. Browser switches to the error screen. The temporary file is GC'd on a 1-hour timer or on `DELETE /jobs/<id>`.

Error codes (full spec in `api-spec.md`):
- `ENCRYPTED` — input is password-protected.
- `NO_TEXT` — page text empty (likely scanned). Suggest `ocrmypdf`.
- `OLLAMA_DOWN` — cannot reach `http://localhost:11434`.
- `MODEL_MISSING` — Ollama is up but `gemma4:e4b` is not pulled.
- `NO_CHAPTERS` — pipeline ran but produced 0 chapters. Offer "save anyway" or "try larger model".
- `INVALID_PDF` — file corrupted past repair.
- `TOO_LARGE` — input > 200 MB (configurable).

## Concurrency model

- **Single async worker** processes jobs serially. The local LLM is the bottleneck — parallel jobs would thrash the GPU/memory.
- File uploads are concurrent (FastAPI handles them async); the bottleneck is downstream of the queue.
- SSE subscribers are per-job; one job can have multiple subscribers (e.g., user opens two tabs).

## Process lifecycle

- `walnut` CLI binds an unused port via `socket.bind(('127.0.0.1', 0))`, launches uvicorn, opens the browser via `webbrowser.open`.
- Uvicorn handles graceful shutdown on SIGINT (`Ctrl-C`).
- Temp files in `/tmp/walnut/` survive crashes; cleaned on next process start.

## Why FastAPI

- Native async, `StreamingResponse`, `EventSourceResponse` via `sse-starlette`.
- Mature ecosystem; plays well with Pydantic v2 (used for schema validation anyway).
- Performance is irrelevant for single-user local — pick the lowest-friction option.

## Why Alpine.js + htmx (no SPA framework)

- Four screens, two forms, one EventSource. A SPA framework would be over-engineered.
- Zero build step. Two `<script src="…">` tags ship the entire frontend.
- ~30 KB total vs. SvelteKit's ~50 KB output for the same surface.

## Why Ollama

- Day-0 Gemma 4 support (April 2026 release).
- Auto-uses MLX backend on Apple Silicon for matmul speedup.
- `format=` parameter accepts a JSON schema and constrains decoding via grammar — output is valid JSON before validation.
- Single binary daemon at `:11434`; no Python in the LLM path.

## Why PyMuPDF for write, not pikepdf

PyMuPDF's `save(incremental=True)` appends a delta region (new objects + xref + trailer chained via `/Prev`) to the original file. Bytes 0..N of the input are byte-identical to the output's prefix. This is the same mechanism PDF signers use to avoid invalidating signatures.

Pikepdf's `save()` always rewrites the whole file. Logically equivalent but bytes shift. We keep it as a fallback for cases where PyMuPDF cannot incremental-save (repaired PDFs, certain encrypted variants).

## Repository layout

```
walnut/
  pyproject.toml
  README.md
  PLAN.md
  LICENSE
  walnut/
    __init__.py            # __version__
    cli.py                 # entry point: parse port, launch uvicorn, open browser
    server.py              # FastAPI app + routes
    queue.py               # JobManager + Job
    pdf.py                 # inspect_pdf, extract_pages, add_outline
    toc.py                 # find_toc_pages, parse_toc
    llm.py                 # OllamaClient, detect_chapters, schemas
    pipeline.py            # process_pdf orchestrator
    confidence.py          # confidence scoring fusion
    errors.py              # WalnutError + code constants
    eval.py                # bench harness
    web/
      index.html
      static/
        style.css
        favicon.svg
        fraunces.woff2
        inter.woff2
        jetbrains-mono.woff2
  tests/
    test_pdf.py
    test_toc.py
    test_llm.py
    test_pipeline.py
    test_queue.py
    test_server.py
    fixtures/
      sample.pdf
      encrypted.pdf
      scanned.pdf
      books/
        book-01-pride-and-prejudice.pdf
        book-01-pride-and-prejudice.yaml
        ...
  scripts/
    build-css.sh
    download-fixtures.sh
```
