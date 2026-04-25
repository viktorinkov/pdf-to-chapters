# walnut

Add proper bookmark/outline structure to PDFs that are missing it, using a local LLM. The output PDF is byte-identical to the input except for an appended outline tree.

## What it does

Many PDFs of books and long documents come without bookmarks — readers can't jump between chapters, and the outline pane stays empty. **walnut** opens the PDF in your browser, runs a local model to detect chapter structure, and saves the same PDF as `walnut-<originalname>.pdf` with a proper nested outline written into it.

- Runs entirely locally. The PDF never leaves your machine.
- Uses [Ollama](https://ollama.com) and Google's open-weights `gemma4:e4b` model.
- Lets you preview and edit the detected chapters before saving.
- Preserves the original PDF byte-for-byte (PDF incremental update).

## Requirements

- macOS 13+ (Apple Silicon recommended) or Linux.
- 16 GB RAM minimum. 32 GB+ unlocks the larger model variants.
- Python 3.12+ — but `uvx` will manage that for you.
- [Ollama](https://ollama.com/download) installed and running.

## Quick start

```bash
# 1. Install Ollama and pull the model
brew install ollama
brew services start ollama
ollama pull gemma4:e4b      # 9.6 GB, fits in 16 GB RAM

# 2. Run walnut, no permanent install
uvx walnut
```

Your browser opens to `http://localhost:<auto-port>`. Drag a PDF in.

To keep walnut installed permanently:

```bash
uv tool install walnut
walnut
```

## How it works

1. **Extract** text and font/structure spans (PyMuPDF).
2. **Detect** a printed Table of Contents page if one exists, parse it.
3. **Confirm or infer** chapters with `gemma4:e4b` via Ollama, constrained to a JSON schema.
4. **Preview** in the browser — rename, renumber, nest, or delete entries.
5. **Write** the outline back into a copy of the PDF using PyMuPDF's incremental save. Only an appended xref/trailer region changes; the original bytes are preserved.

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Status

Pre-implementation. Planning complete. See [`PLAN.md`](PLAN.md) for the phased roadmap.

## License

MIT. Note that PyMuPDF is AGPL — using it via the dependency in this MIT project is fine, but commercial redistribution requires a PyMuPDF commercial license or a switch to pikepdf-only (see `docs/pdf-processing.md`).
