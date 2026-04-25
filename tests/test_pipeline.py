from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

import pymupdf
import pytest

from walnut.errors import ENCRYPTED, NO_TEXT, WalnutError
from walnut.pipeline import process_pdf
from walnut.queue import Job


def _make_job(src_path: str, *, page_count: int, out_path: str | None = None) -> Job:
    out = out_path or os.path.join(os.path.dirname(src_path), "walnut-out.pdf")
    return Job(
        id="j_test",
        src_path=src_path,
        out_path=out,
        orig_name="out.pdf",
        page_count=page_count,
    )


@pytest.mark.asyncio
async def test_pipeline_toc_only_mode_processes_fixture(
    fixture_pdf: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: TOC mode, no LLM. Confirms the pipeline reaches preview, then writes."""
    monkeypatch.setenv("WALNUT_LLM_MODE", "off")

    out_path = tmp_path / "walnut-fixture.pdf"
    job = _make_job(str(fixture_pdf), page_count=10, out_path=str(out_path))

    events: list[tuple[str, dict[str, Any]]] = []
    preview_seen = asyncio.Event()

    async def emit(j: Job, event: str, data: dict[str, Any]) -> None:
        events.append((event, data))
        if event == "preview":
            preview_seen.set()

    async def confirm_when_ready() -> None:
        await preview_seen.wait()
        # Use the chapters from the preview as-is.
        last_preview = next((d for e, d in reversed(events) if e == "preview"), None)
        assert last_preview is not None
        job.confirmed_chapters = last_preview["chapters"]
        job.awaiting_confirmation.set()

    pipeline_task = asyncio.create_task(process_pdf(job, emit))
    confirmer_task = asyncio.create_task(confirm_when_ready())
    await asyncio.gather(pipeline_task, confirmer_task)

    kinds = [e for e, _ in events]
    assert "preview" in kinds
    assert "complete" in kinds

    assert out_path.exists()
    # Verify the output PDF actually has the right chapters.
    doc = pymupdf.open(str(out_path))
    try:
        toc = doc.get_toc(simple=True)
    finally:
        doc.close()
    assert len(toc) == 3
    titles = [row[1] for row in toc]
    assert "Chapter 1" in titles


@pytest.mark.asyncio
async def test_pipeline_encrypted_raises_walnut_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WALNUT_LLM_MODE", "off")

    enc = tmp_path / "encrypted.pdf"
    doc = pymupdf.open()
    try:
        doc.new_page()
        doc.save(
            str(enc),
            encryption=pymupdf.PDF_ENCRYPT_AES_256,
            owner_pw="owner",
            user_pw="user",
        )
    finally:
        doc.close()

    job = _make_job(str(enc), page_count=1)

    async def emit(j: Job, event: str, data: dict[str, Any]) -> None:
        pass

    with pytest.raises(WalnutError) as exc:
        await process_pdf(job, emit)
    assert exc.value.code == ENCRYPTED


@pytest.mark.asyncio
async def test_pipeline_no_text_raises_walnut_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WALNUT_LLM_MODE", "off")

    img_pdf = tmp_path / "image_only.pdf"
    doc = pymupdf.open()
    try:
        # Create a single-page PDF with a full-page image and no text.
        page = doc.new_page(width=600, height=800)
        # Build a 1x1 white pixmap and stretch over the page.
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 1, 1))
        pix.clear_with(255)
        page.insert_image(page.rect, pixmap=pix)
        doc.save(str(img_pdf))
    finally:
        doc.close()

    job = _make_job(str(img_pdf), page_count=1)

    async def emit(j: Job, event: str, data: dict[str, Any]) -> None:
        pass

    with pytest.raises(WalnutError) as exc:
        await process_pdf(job, emit)
    assert exc.value.code == NO_TEXT
