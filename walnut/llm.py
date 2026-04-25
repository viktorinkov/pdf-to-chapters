from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING, Any

import httpx

from .schemas import ChapterList

if TYPE_CHECKING:
    from .pdf import PageDigest

OLLAMA_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_MODEL = "gemma4:e4b"

# Sampling defaults mirror docs/prompts.md; repeat_penalty=1.0 intentional because chapter
# titles legitimately repeat words (e.g., "Chapter 1", "Chapter 2").
DEFAULT_OPTIONS: dict[str, Any] = {
    "temperature": 0.2,
    "top_p": 0.95,
    "num_ctx": 131072,
    "repeat_penalty": 1.0,
}

SYSTEM_PROMPT = """You are a document-structure analyzer. You extract a clean list of chapters
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
Document font-size distribution: p50={size_p50}pt, p90={size_p90}pt, p99={size_p99}pt"""


TOC_USER_PROMPT_TEMPLATE = """The following text was extracted from the printed Table of Contents page(s)
of a book. Each line is one entry plus a printed page reference.

Convert it to a structured chapter list. Use indentation and decimal
numbering (e.g., "3.1", "3.1.2") to determine `level`.

INPUT:
{toc_text}

Return chapters in document order. If a line obviously isn't a chapter
(running headers, page footers), drop it."""


FULLTEXT_USER_PROMPT_TEMPLATE = """Extract the chapter list from the PDF text below.

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
{{"chapters":[
  {{"title":"PROLOGUE",                "page_number":1,  "level":1}},
  {{"title":"Chapter 1: Beginnings",   "page_number":12, "level":1}},
  {{"title":"Chapter 2: The Journey",  "page_number":45, "level":1}},
  {{"title":"2.1 Departure",           "page_number":45, "level":2}}
]}}

Now process the following document:

{annotated_text}"""


class OllamaClient:
    """Thin async wrapper over the Ollama REST API.

    We use httpx rather than the ollama SDK so the pipeline keeps a single HTTP client
    stack and we can swap LLM providers without losing the abstraction.
    """

    def __init__(
        self,
        base_url: str = OLLAMA_BASE_URL,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 600.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        # Long timeout because generating 200+ chapter entries on a cold model can
        # legitimately take 2+ minutes.
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None

    async def chat(
        self,
        model: str,
        messages: list[dict[str, str]],
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        if format is not None:
            payload["format"] = format
        if options is not None:
            payload["options"] = options
        response = await self._client.post(f"{self.base_url}/api/chat", json=payload)
        response.raise_for_status()
        return response.json()

    async def is_reachable(self) -> bool:
        try:
            response = await self._client.get(f"{self.base_url}/api/tags")
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def has_model(self, name: str) -> bool:
        try:
            response = await self._client.get(f"{self.base_url}/api/tags")
            response.raise_for_status()
        except httpx.HTTPError:
            return False
        body = response.json()
        models = body.get("models", [])
        for m in models:
            model_name = m.get("name", "")
            # Accept exact match and prefix match ("gemma4:e4b" matches "gemma4:e4b-q8_0").
            if (
                model_name == name
                or model_name.startswith(f"{name}:")
                or model_name.startswith(f"{name}-")
            ):
                return True
        return False

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def _coalesce_spans_by_line(spans: list[Any]) -> list[dict[str, Any]]:
    """Group spans on the same vertical line into a single annotated entry.

    PyMuPDF emits one Span per styled run; a visually-single line of text with a
    bold word in it produces two Spans. We bucket by rounded y0 and merge text,
    keeping the max size / OR'd flags so heading detection stays conservative.
    """
    if not spans:
        return []
    # Round y0 so sub-pixel jitter doesn't split lines.
    buckets: dict[float, list[Any]] = defaultdict(list)
    for sp in spans:
        y0 = round(float(sp.bbox[1]), 1)
        buckets[y0].append(sp)
    lines: list[dict[str, Any]] = []
    for y0 in sorted(buckets):
        group = sorted(buckets[y0], key=lambda s: float(s.bbox[0]))
        text = "".join(s.text for s in group).strip()
        if not text:
            continue
        size = max(float(s.size) for s in group)
        flags = 0
        for s in group:
            flags |= int(s.flags)
        lines.append({"text": text, "size": size, "flags": flags, "y0": y0})
    return lines


def annotate(digest: PageDigest) -> str:
    """Convert a PageDigest to the `[p. <label>, sz=Xpt, <flags>] text` format.

    Spans on the same y-position coalesce into a single line; see `_coalesce_spans_by_line`.
    """
    out: list[str] = [f"### START_PAGE={digest.page_label}"]
    for line in _coalesce_spans_by_line(digest.spans):
        flags: list[str] = []
        # PyMuPDF flag bits per docs/pdf-processing.md: 4=serif, 16=bold, 1=italic.
        if line["flags"] & 16:
            flags.append("bold")
        if line["flags"] & 1:
            flags.append("italic")
        flag_str = ", " + ", ".join(flags) if flags else ""
        size = line["size"]
        size_str = f"{size:g}"
        out.append(f"[p. {digest.page_label}, sz={size_str}pt{flag_str}] {line['text']}")
    return "\n".join(out)


def _format_system_prompt(lang: str, p50: float, p90: float, p99: float) -> str:
    return SYSTEM_PROMPT.format(
        lang_code=lang,
        size_p50=f"{p50:g}",
        size_p90=f"{p90:g}",
        size_p99=f"{p99:g}",
    )


async def _chat_for_chapters(
    client: OllamaClient,
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    options: dict[str, Any] | None = None,
) -> ChapterList:
    """Issue one /api/chat call with structured output and parse into ChapterList.

    Ollama #15260: even with `format=schema`, thinking models occasionally emit a
    leading thought block that breaks validation. Retry once; if it still fails, raise.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    fmt = ChapterList.model_json_schema()
    opts = options if options is not None else DEFAULT_OPTIONS

    last_error: Exception | None = None
    for attempt in range(2):
        body = await client.chat(model=model, messages=messages, format=fmt, options=opts)
        content = body.get("message", {}).get("content", "")
        try:
            return ChapterList.model_validate_json(content)
        except ValueError as e:
            last_error = e
            if attempt == 0:
                continue
            raise
    # Unreachable — loop either returns or raises.
    raise RuntimeError(f"chapter parsing failed: {last_error}")


async def detect_chapters_from_toc(
    client: OllamaClient,
    toc_text: str,
    lang: str,
    p50: float,
    p90: float,
    p99: float,
    model: str = DEFAULT_MODEL,
) -> ChapterList:
    """Normalize already-extracted TOC text into a structured ChapterList."""
    system_prompt = _format_system_prompt(lang, p50, p90, p99)
    user_prompt = TOC_USER_PROMPT_TEMPLATE.format(toc_text=toc_text)
    return await _chat_for_chapters(
        client,
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )


async def detect_chapters_fulltext(
    client: OllamaClient,
    annotated_text: str,
    lang: str,
    p50: float,
    p90: float,
    p99: float,
    model: str = DEFAULT_MODEL,
) -> ChapterList:
    """Detect chapters from annotated full-text (or candidate-page) input."""
    system_prompt = _format_system_prompt(lang, p50, p90, p99)
    user_prompt = FULLTEXT_USER_PROMPT_TEMPLATE.format(annotated_text=annotated_text)
    return await _chat_for_chapters(
        client,
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )
