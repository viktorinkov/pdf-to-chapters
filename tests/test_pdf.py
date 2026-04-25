from __future__ import annotations

from pathlib import Path

import pymupdf

from walnut.pdf import (
    Chapter,
    _verify_byte_prefix,
    add_outline,
    extract_pages,
    inspect_pdf,
    logical_to_physical,
)


def test_inspect_pdf(fixture_pdf: Path) -> None:
    info = inspect_pdf(str(fixture_pdf))
    assert info["pages"] == 10
    assert not info["encrypted"]
    assert not info["needs_password"]
    assert not info["has_existing_toc"]
    assert info["page_labels"] == []


def test_extract_pages(fixture_pdf: Path) -> None:
    digests = extract_pages(str(fixture_pdf))
    assert len(digests) == 10
    for d in digests:
        assert d.text.strip(), f"page {d.page_idx} has no text"
        assert d.spans, f"page {d.page_idx} has no spans"
    assert "The Book of Walnuts" in digests[0].text
    assert "Chapter 1" in digests[2].text


def test_logical_to_physical_no_labels(fixture_pdf: Path) -> None:
    assert logical_to_physical("3", [], 10) == 2
    assert logical_to_physical("11", [], 10) is None
    assert logical_to_physical("iv", [], 10) is None


def test_add_outline_and_verify(fixture_pdf: Path, tmp_path: Path) -> None:
    chapters = [
        Chapter(title="Chapter 1", physical_page_idx=2, printed_label="3", confidence=1.0),
        Chapter(title="Chapter 2", physical_page_idx=5, printed_label="6", confidence=1.0),
        Chapter(title="Chapter 3", physical_page_idx=8, printed_label="9", confidence=1.0),
    ]
    out = tmp_path / "walnut-fixture.pdf"
    add_outline(str(fixture_pdf), chapters, str(out))
    assert out.exists()

    # Byte-prefix preserved by incremental save.
    _verify_byte_prefix(fixture_pdf, out)

    # Re-open and verify the TOC.
    doc = pymupdf.open(str(out))
    try:
        toc = doc.get_toc(simple=True)
    finally:
        doc.close()

    assert len(toc) == 3
    # PyMuPDF get_toc returns [[level, title, page], ...] with 1-based page.
    assert [row[1] for row in toc] == ["Chapter 1", "Chapter 2", "Chapter 3"]
    assert [row[2] for row in toc] == [3, 6, 9]
    assert all(row[0] == 1 for row in toc)
