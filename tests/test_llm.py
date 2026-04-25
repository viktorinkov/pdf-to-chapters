from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import respx

from walnut.llm import (
    DEFAULT_MODEL,
    FULLTEXT_USER_PROMPT_TEMPLATE,
    OLLAMA_BASE_URL,
    SYSTEM_PROMPT,
    TOC_USER_PROMPT_TEMPLATE,
    OllamaClient,
    annotate,
    detect_chapters_from_toc,
)
from walnut.schemas import ChapterEntry, ChapterList

# --- Test helpers -----------------------------------------------------------


@dataclass
class FakeSpan:
    text: str
    size: float
    font: str
    flags: int
    bbox: tuple[float, float, float, float]
    page_idx: int
    page_label: str


@dataclass
class FakePageDigest:
    page_idx: int
    page_label: str
    text: str
    spans: list[FakeSpan] = field(default_factory=list)
    is_image_only: bool = False


# --- Schema ----------------------------------------------------------------


def test_schemas_valid_json() -> None:
    payload = json.dumps(
        {
            "chapters": [
                {"title": "Prologue", "page_number": 1, "level": 1},
                {"title": "1.1 The Beginning", "page_number": 3, "level": 2},
            ]
        }
    )
    result = ChapterList.model_validate_json(payload)
    assert len(result.chapters) == 2
    assert result.chapters[0] == ChapterEntry(title="Prologue", page_number=1, level=1)
    assert result.chapters[1].level == 2


def test_schema_rejects_page_zero() -> None:
    with pytest.raises(ValueError):
        ChapterEntry(title="Bad", page_number=0, level=1)


def test_schema_rejects_level_out_of_range() -> None:
    with pytest.raises(ValueError):
        ChapterEntry(title="Bad", page_number=1, level=4)  # type: ignore[arg-type]


# --- Prompts ---------------------------------------------------------------


def test_prompt_templates_format_without_stray_braces() -> None:
    # Ensure the curly braces in the EXAMPLE OUTPUT weren't accidentally left as
    # format placeholders. These .format() calls would raise KeyError otherwise.
    sys_prompt = SYSTEM_PROMPT.format(
        lang_code="en",
        size_p50=11,
        size_p90=14,
        size_p99=18,
    )
    assert "en" in sys_prompt
    assert "p50=11pt" in sys_prompt

    toc = TOC_USER_PROMPT_TEMPLATE.format(toc_text="Chapter 1 ..... 1")
    assert "Chapter 1 ..... 1" in toc

    fulltext = FULLTEXT_USER_PROMPT_TEMPLATE.format(annotated_text="[p. 1, sz=14pt] Foo")
    assert "[p. 1, sz=14pt] Foo" in fulltext
    # The example output JSON literal braces must survive.
    assert '"chapters"' in fulltext


# --- Annotation ------------------------------------------------------------


def test_annotate_format() -> None:
    spans = [
        # Two spans on the same y (bold run + regular run in the same line).
        FakeSpan(
            text="Chapter ",
            size=18.0,
            font="Times-Bold",
            flags=16,
            bbox=(72.0, 100.0, 140.0, 120.0),
            page_idx=11,
            page_label="12",
        ),
        FakeSpan(
            text="1: Beginnings",
            size=18.0,
            font="Times-Bold",
            flags=16,
            bbox=(140.0, 100.0, 300.0, 120.0),
            page_idx=11,
            page_label="12",
        ),
        FakeSpan(
            text="The room was dark...",
            size=11.0,
            font="Times-Roman",
            flags=0,
            bbox=(72.0, 140.0, 400.0, 154.0),
            page_idx=11,
            page_label="12",
        ),
    ]
    digest = FakePageDigest(
        page_idx=11, page_label="12", text="Chapter 1: Beginnings\nThe room was dark...", spans=spans
    )
    result = annotate(digest)
    lines = result.splitlines()
    assert lines[0] == "### START_PAGE=12"
    # The two heading spans should coalesce into one line.
    assert lines[1] == "[p. 12, sz=18pt, bold] Chapter 1: Beginnings"
    assert lines[2] == "[p. 12, sz=11pt] The room was dark..."


def test_annotate_empty_spans_returns_just_header() -> None:
    digest = FakePageDigest(page_idx=0, page_label="1", text="", spans=[])
    result = annotate(digest)
    assert result == "### START_PAGE=1"


def test_annotate_italic_flag() -> None:
    spans = [
        FakeSpan(
            text="italic heading",
            size=14.0,
            font="Times-Italic",
            flags=1,
            bbox=(72.0, 100.0, 300.0, 115.0),
            page_idx=0,
            page_label="1",
        ),
    ]
    digest = FakePageDigest(page_idx=0, page_label="1", text="italic heading", spans=spans)
    result = annotate(digest)
    assert "italic" in result
    assert "bold" not in result


# --- HTTP client -----------------------------------------------------------


@pytest.mark.asyncio
async def test_is_reachable_true_on_200() -> None:
    with respx.mock(base_url=OLLAMA_BASE_URL) as router:
        router.get("/api/tags").mock(return_value=httpx.Response(200, json={"models": []}))
        client = OllamaClient()
        try:
            assert await client.is_reachable() is True
        finally:
            await client.aclose()


@pytest.mark.asyncio
async def test_is_reachable_false_on_connection_error() -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(500))) as httpx_client:
        client = OllamaClient(client=httpx_client)
        try:
            # 500 isn't a connection error; we just want not-200 returns False.
            assert await client.is_reachable() is False
        finally:
            await client.aclose()


@pytest.mark.asyncio
async def test_has_model_matches_exact_and_prefix() -> None:
    with respx.mock(base_url=OLLAMA_BASE_URL) as router:
        router.get("/api/tags").mock(
            return_value=httpx.Response(
                200, json={"models": [{"name": "gemma4:e4b"}, {"name": "llama3:8b"}]}
            )
        )
        client = OllamaClient()
        try:
            assert await client.has_model("gemma4:e4b") is True
            assert await client.has_model("nope") is False
        finally:
            await client.aclose()


# --- detect_chapters_from_toc ---------------------------------------------


@pytest.mark.asyncio
async def test_detect_chapters_from_toc() -> None:
    fake_output = {
        "message": {
            "content": json.dumps(
                {
                    "chapters": [
                        {"title": "Chapter 1", "page_number": 1, "level": 1},
                        {"title": "Chapter 2", "page_number": 21, "level": 1},
                    ]
                }
            )
        }
    }
    with respx.mock(base_url=OLLAMA_BASE_URL) as router:
        route = router.post("/api/chat").mock(return_value=httpx.Response(200, json=fake_output))
        client = OllamaClient()
        try:
            result = await detect_chapters_from_toc(
                client,
                toc_text="Chapter 1 ........ 1\nChapter 2 ........ 21",
                lang="en",
                p50=11.0,
                p90=14.0,
                p99=18.0,
            )
        finally:
            await client.aclose()
    assert route.called
    assert len(result.chapters) == 2
    assert result.chapters[0].title == "Chapter 1"
    assert result.chapters[1].page_number == 21

    # Verify the sent payload includes the TOC text, language, and schema.
    sent_body = json.loads(route.calls[0].request.content)
    assert sent_body["model"] == DEFAULT_MODEL
    assert sent_body["stream"] is False
    assert "format" in sent_body
    messages = sent_body["messages"]
    assert any("en" in m["content"] for m in messages if m["role"] == "system")
    assert any("Chapter 1 ........ 1" in m["content"] for m in messages if m["role"] == "user")


@pytest.mark.asyncio
async def test_detect_chapters_retries_once_on_parse_failure() -> None:
    bad_content = {"message": {"content": "not json at all"}}
    good_content = {
        "message": {
            "content": json.dumps({"chapters": [{"title": "X", "page_number": 1, "level": 1}]})
        }
    }
    # Alternating responses: first bad, then good.
    responses = [
        httpx.Response(200, json=bad_content),
        httpx.Response(200, json=good_content),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return responses.pop(0)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as httpx_client:
        client = OllamaClient(client=httpx_client)
        try:
            result = await detect_chapters_from_toc(
                client, toc_text="x", lang="en", p50=11.0, p90=14.0, p99=18.0
            )
        finally:
            await client.aclose()
    assert len(result.chapters) == 1
    assert result.chapters[0].title == "X"


@pytest.mark.asyncio
async def test_detect_chapters_raises_after_two_failures() -> None:
    bad = {"message": {"content": "still not json"}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=bad)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as httpx_client:
        client = OllamaClient(client=httpx_client)
        try:
            with pytest.raises(ValueError):
                await detect_chapters_from_toc(
                    client, toc_text="x", lang="en", p50=11.0, p90=14.0, p99=18.0
                )
        finally:
            await client.aclose()


@pytest.mark.asyncio
async def test_chat_passes_options_and_format() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": "ok"}})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as httpx_client:
        client = OllamaClient(client=httpx_client)
        try:
            await client.chat(
                model="m",
                messages=[{"role": "user", "content": "hi"}],
                format={"type": "object"},
                options={"temperature": 0.1},
            )
        finally:
            await client.aclose()
    assert captured["body"]["format"] == {"type": "object"}
    assert captured["body"]["options"] == {"temperature": 0.1}
    assert captured["body"]["stream"] is False
