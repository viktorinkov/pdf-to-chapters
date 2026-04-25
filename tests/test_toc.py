from __future__ import annotations

from pathlib import Path

from walnut.pdf import Chapter, extract_pages
from walnut.toc import TOC_LINE_RE, find_toc_pages, parse_toc


def test_toc_line_re_dot_leader() -> None:
    m = TOC_LINE_RE.match("Chapter 1 ........ 3")
    assert m is not None
    assert m.group(1).strip() == "Chapter 1"
    assert m.group(2) == "3"


def test_toc_line_re_ellipsis() -> None:
    m = TOC_LINE_RE.match("Introduction ………… iv")
    assert m is not None
    assert m.group(1).strip() == "Introduction"
    assert m.group(2) == "iv"


def test_find_toc_pages(fixture_pdf: Path) -> None:
    digests = extract_pages(str(fixture_pdf))
    toc_pages = find_toc_pages(digests)
    assert toc_pages, "expected at least one TOC page"
    page_indices = [pi for pi, _ in toc_pages]
    assert 1 in page_indices  # physical page 2 is 0-indexed 1
    entries = dict(toc_pages[0][1])
    assert "Chapter 1" in entries
    assert entries["Chapter 1"] == "3"


def test_parse_toc(fixture_pdf: Path) -> None:
    digests = extract_pages(str(fixture_pdf))
    toc_pages = find_toc_pages(digests)
    chapters = parse_toc(toc_pages, page_labels=[], n_pages=10)
    assert len(chapters) == 3
    assert chapters[0].title == "Chapter 1"
    assert chapters[0].physical_page_idx == 2
    assert chapters[0].printed_label == "3"
    assert chapters[1].physical_page_idx == 5
    assert chapters[2].physical_page_idx == 8
    assert all(not ch.children for ch in chapters)


def test_parse_toc_decimal_nesting() -> None:
    toc_pages = [
        (
            1,
            [
                ("3 Foundations", "10"),
                ("3.1 Motivation", "11"),
                ("3.2 History", "15"),
                ("4 Applications", "20"),
            ],
        )
    ]
    chapters = parse_toc(toc_pages, page_labels=[], n_pages=50)
    assert len(chapters) == 2
    assert chapters[0].title == "3 Foundations"
    assert [c.title for c in chapters[0].children] == [
        "3.1 Motivation",
        "3.2 History",
    ]
    assert chapters[1].title == "4 Applications"
    assert not chapters[1].children
