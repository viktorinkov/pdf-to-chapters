# LLM Prompts & Schema

Production prompts and JSON schemas used by `walnut/llm.py`. Tuned for `gemma4:e4b` via Ollama with the `format=` constrained-decoding parameter.

## JSON schema (Pydantic)

```python
from pydantic import BaseModel, Field
from typing import Literal

class ChapterEntry(BaseModel):
    title: str = Field(description="Chapter or section title as printed in the book.")
    page_number: int = Field(
        description="Printed page label (NOT physical index) where the chapter starts.",
        ge=1,
    )
    level: Literal[1, 2, 3] = Field(
        description="1 = chapter or part, 2 = section, 3 = sub-section."
    )

class ChapterList(BaseModel):
    chapters: list[ChapterEntry]
```

When called with `format=ChapterList.model_json_schema()`, Ollama compiles the schema into a llama.cpp grammar that constrains the sampler. Output is guaranteed valid JSON matching the schema.

## System prompt

```
You are a document-structure analyzer. You extract a clean list of chapters
and sections from extracted PDF text.

Rules:
1. Return ONLY entries that correspond to actual chapter/section headings in
   the printed book — never include front-matter (copyright, dedication,
   acknowledgments) unless they are clearly numbered or part of the author's
   structure.
2. `page_number` must be the 1-indexed printed page label where the chapter
   STARTS, not the TOC reference. Page anchors in the text appear as lines
   like "### START_PAGE=42".
3. `level`: 1 = chapter or part, 2 = section within a chapter, 3 = sub-
   section. Maximum depth 3.
4. If chapter numbering is ambiguous (e.g. unnumbered prologue/epilogue,
   mixed Roman + Arabic), keep the title verbatim and assign level 1 to
   anything that looks book-level. Do not invent numbers.
5. Preserve the title's original capitalization, punctuation, and language.
   Do not translate.
6. If you find duplicate chapter titles at different pages, keep both — they
   may be distinct.
7. A chapter must have a heading-style line (font >= p90 of document).
8. Return entries in the order they appear in the document (ascending
   page_number).
9. Return [] if nothing chapter-like is found.

Document language (auto-detected): {lang_code}
Document font-size distribution: p50={size_p50}pt, p90={size_p90}pt, p99={size_p99}pt
```

`{lang_code}` comes from `langdetect` on the first 5 pages. `{size_p50/90/99}` are computed from the spans collected during extraction.

## User prompt — full-text path

```
Extract the chapter list from the PDF text below.

Each line is annotated with `[p. <label>, sz=<font_size>pt, <flags>]` where
flags can include `bold`, `italic`. Body text is shown without `bold`.

EXAMPLE INPUT:
[p. 1,  sz=14pt, bold]  PROLOGUE
[p. 1,  sz=11pt]        The room was dark...
[p. 12, sz=18pt, bold]  Chapter 1: Beginnings
[p. 12, sz=11pt]        ...
[p. 45, sz=18pt, bold]  Chapter 2: The Journey
[p. 45, sz=14pt, bold]  2.1 Departure
[p. 45, sz=11pt]        ...

EXAMPLE OUTPUT:
{"chapters":[
  {"title":"PROLOGUE",                "page_number":1,  "level":1},
  {"title":"Chapter 1: Beginnings",   "page_number":12, "level":1},
  {"title":"Chapter 2: The Journey",  "page_number":45, "level":1},
  {"title":"2.1 Departure",           "page_number":45, "level":2}
]}

Now process the following document:

{annotated_text}
```

## User prompt — TOC-page-only path (preferred when available)

```
The following text was extracted from the printed Table of Contents page(s)
of a book. Each line is one entry plus a printed page reference.

Convert it to a structured chapter list. Use indentation and decimal
numbering (e.g., "3.1", "3.1.2") to determine `level`.

INPUT:
{toc_text}

Return chapters in document order. If a line obviously isn't a chapter
(running headers, page footers), drop it.
```

This prompt is short (~3 k tokens incl. TOC) and returns the answer in 5–10 s
even on `gemma4:e4b`. Use it whenever `find_toc_pages` returns ≥ 3 entries.

## Sampling options

```python
options = {
    "temperature": 0.2,    # low but not zero — helps with ambiguous numbering
    "top_p": 0.95,
    "num_ctx": 131072,     # full 128k for E4B; raise to 262144 for 26b/31b
    "repeat_penalty": 1.0, # no penalty — chapter lists legitimately repeat words
}
```

For self-consistency, the second pass uses the same prompt at `temperature=0.3` and `seed=42`. Intersect the two outputs for high-confidence chapters; symmetric difference becomes yellow-flagged.

## Annotation format

For the full-text path, we transform the page text by walking the spans collected during extraction:

```python
def annotate(digest: PageDigest, body_size_p90: float) -> str:
    out = [f"### START_PAGE={digest.page_label}"]
    for span in _coalesce_to_lines(digest.spans):
        flags = []
        if span.flags & 16: flags.append("bold")
        if span.flags & 1:  flags.append("italic")
        flag_str = ", " + ", ".join(flags) if flags else ""
        out.append(f"[p. {digest.page_label}, sz={span.size:g}pt{flag_str}] {span.text}")
    return "\n".join(out)
```

`_coalesce_to_lines` groups spans on the same y-position into a single annotated line — otherwise we'd produce 2× the tokens for nothing.

## Token budget

- TOC-only path: 1–3 k input, ~2 k output. One call per book.
- Full-text path on 300-page book: ~75 k input. One call if context fits, else windowed.
- Constrained-candidate-pages path: ~10–15 k input (only candidate pages). Preferred fallback.

For documents needing the windowed path, each window is 80 k tokens with 10 k overlap. Each window prepends a header `### START_PAGE=<label>` so the model can ground page references when they cross the window boundary.

## Failure-handling

The constrained-decoding guarantee covers schema validity, not semantic correctness. The pipeline still validates the LLM output:

1. **Schema validate** with `ChapterList.model_validate_json` (will not fail thanks to `format=`).
2. **Page bounds** — drop entries with `page_number > total_pages` or `< 1`.
3. **Title presence** — drop entries whose title doesn't appear (fuzzy match) on the claimed page ±2.
4. **Monotonic order** — sort by `(page_number, level)`; drop any entry that goes backwards by more than 1 page.
5. **Length** — drop titles > 200 chars (clear hallucination).

After validation, the survivors are scored for confidence (see `quality-evaluation.md`) and surfaced to the preview screen.
