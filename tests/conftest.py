from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest


def _build_fixture(path: Path) -> None:
    doc = pymupdf.open()
    try:
        # Page 1: title.
        p0 = doc.new_page()
        p0.insert_text((72, 120), "The Book of Walnuts", fontsize=28, fontname="helv")
        p0.insert_text((72, 160), "by A. N. Author", fontsize=14, fontname="helv")

        # Page 2: TOC with dot-leaders. Pad leaders with many dots to guarantee
        # the regex matches even when PyMuPDF's text extraction compresses
        # whitespace.
        p1 = doc.new_page()
        p1.insert_text((72, 100), "Contents", fontsize=20, fontname="helv")
        toc_lines = [
            ("Chapter 1", "3"),
            ("Chapter 2", "6"),
            ("Chapter 3", "9"),
        ]
        y = 160
        for title, pg in toc_lines:
            leader = "." * 40
            p1.insert_text((72, y), f"{title} {leader} {pg}", fontsize=12, fontname="helv")
            y += 30

        # Pages 3-10, where physical 3,6,9 (0-indexed 2,5,8) begin chapters.
        # We need pages 3..10 -> 8 pages. Page 3 = Chapter 1 start etc.
        chapter_starts = {2: "Chapter 1", 5: "Chapter 2", 8: "Chapter 3"}
        for i in range(2, 10):
            page = doc.new_page()
            if i in chapter_starts:
                page.insert_text((72, 100), chapter_starts[i], fontsize=24, fontname="hebo")
                page.insert_text(
                    (72, 160),
                    f"This is the start of {chapter_starts[i]}. Lorem ipsum dolor sit amet.",
                    fontsize=12,
                    fontname="helv",
                )
            else:
                page.insert_text(
                    (72, 100),
                    f"Body text on physical page {i + 1}.",
                    fontsize=12,
                    fontname="helv",
                )
        doc.save(str(path))
    finally:
        doc.close()


@pytest.fixture(scope="session")
def fixture_pdf(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("pdfs") / "fixture.pdf"
    _build_fixture(path)
    return path
