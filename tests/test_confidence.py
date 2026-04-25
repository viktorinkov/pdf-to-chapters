from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from walnut.confidence import (
    THRESHOLD_CLEAN,
    THRESHOLD_LOW,
    flag_from_score,
    score_chapter,
    validate_chapters,
)
from walnut.schemas import ChapterEntry

# --- Fake PDF domain objects -----------------------------------------------


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
    text: str = ""
    spans: list[FakeSpan] = field(default_factory=list)
    is_image_only: bool = False


def _page_with_heading(
    label: str, *, idx: int, size: float, y_top: float = 50.0, page_height: float = 720.0
) -> FakePageDigest:
    spans = [
        FakeSpan(
            text="CHAPTER ONE",
            size=size,
            font="Times-Bold",
            flags=16,
            bbox=(72.0, y_top, 300.0, y_top + size),
            page_idx=idx,
            page_label=label,
        ),
        FakeSpan(
            text="body text that extends to the bottom of the page",
            size=11.0,
            font="Times-Roman",
            flags=0,
            bbox=(72.0, 200.0, 500.0, page_height),
            page_idx=idx,
            page_label=label,
        ),
    ]
    return FakePageDigest(page_idx=idx, page_label=label, spans=spans)


# --- score_chapter boundaries ----------------------------------------------


def test_confidence_scoring_all_signals_max_yields_one() -> None:
    entry = ChapterEntry(title="Chapter One", page_number=5, level=1)
    toc = [ChapterEntry(title="Chapter One", page_number=5, level=1)]
    digests = [_page_with_heading(str(i + 1), idx=i, size=18.0) for i in range(10)]
    score = score_chapter(
        entry,
        page_digests=digests,
        toc_candidates=toc,
        llm_logprob=0.0,  # exp(0) = 1.0
        self_consistency_hit=True,
        body_size_p95=14.0,
    )
    assert score == pytest.approx(1.0)


def test_confidence_scoring_all_signals_min_yields_zero() -> None:
    entry = ChapterEntry(title="Mismatch", page_number=99, level=1)
    # TOC ran but disagrees, no heading on a (missing) page, tiny logprob, no self-consistency.
    toc: list[ChapterEntry] = []
    score = score_chapter(
        entry,
        page_digests=[],
        toc_candidates=toc,
        llm_logprob=-1000.0,  # exp(-1000) -> ~0
        self_consistency_hit=False,
        body_size_p95=14.0,
    )
    # Self-consistency is 0.5 even when False, so the floor is 0.15 * 0.5 = 0.075.
    # To reach 0.0 we'd need to rethink the contract; the current docs assign 0.5
    # on miss. We just check it's at or below that floor.
    assert score <= 0.15 * 0.5 + 1e-6


def test_confidence_scoring_mixed_signals() -> None:
    entry = ChapterEntry(title="Chapter One", page_number=5, level=1)
    toc = [ChapterEntry(title="Chapter One", page_number=5, level=1)]
    digests = [_page_with_heading(str(i + 1), idx=i, size=18.0) for i in range(10)]
    # logprob = ln(0.5) -> probability 0.5; agreement 1.0; heuristic 1.0; self-consistency miss 0.5
    import math

    score = score_chapter(
        entry,
        page_digests=digests,
        toc_candidates=toc,
        llm_logprob=math.log(0.5),
        self_consistency_hit=False,
        body_size_p95=14.0,
    )
    expected = 0.35 * 0.5 + 0.30 * 1.0 + 0.20 * 1.0 + 0.15 * 0.5
    assert score == pytest.approx(expected, abs=1e-6)


def test_confidence_heading_heuristic_misses_when_below_p95() -> None:
    entry = ChapterEntry(title="Chapter One", page_number=1, level=1)
    # Heading at 12pt, p95 = 16 -> not a heading.
    digests = [_page_with_heading("1", idx=0, size=12.0)]
    score = score_chapter(
        entry,
        page_digests=digests,
        toc_candidates=None,  # LLM-only -> agreement 0.5
        llm_logprob=0.0,
        self_consistency_hit=True,
        body_size_p95=16.0,
    )
    # heuristic 0, agreement 0.5, logprob 1.0, self_consistency 1.0
    expected = 0.35 * 1.0 + 0.30 * 0.5 + 0.20 * 0.0 + 0.15 * 1.0
    assert score == pytest.approx(expected, abs=1e-6)


def test_confidence_score_clamped() -> None:
    entry = ChapterEntry(title="X", page_number=1, level=1)
    # Positive logprob is degenerate; helper saturates at 1.0.
    score = score_chapter(
        entry,
        page_digests=None,
        toc_candidates=None,
        llm_logprob=1.0,
        self_consistency_hit=True,
        body_size_p95=None,
    )
    assert 0.0 <= score <= 1.0


# --- flag_from_score -------------------------------------------------------


def test_flag_from_score_thresholds() -> None:
    assert flag_from_score(1.0) is None
    assert flag_from_score(THRESHOLD_CLEAN) is None
    assert flag_from_score(THRESHOLD_CLEAN - 0.01) == "low_conf"
    assert flag_from_score(THRESHOLD_LOW) == "low_conf"
    assert flag_from_score(THRESHOLD_LOW - 0.01) == "very_low"
    assert flag_from_score(0.0) == "very_low"


# --- validate_chapters -----------------------------------------------------


def test_validate_drops_bad() -> None:
    digests: list[Any] = [
        FakePageDigest(page_idx=i, page_label=str(i + 1)) for i in range(10)
    ]
    entries = [
        ChapterEntry(title="Good", page_number=1, level=1),
        ChapterEntry(title="Out of range", page_number=999, level=1),
        ChapterEntry(title="a" * 250, page_number=2, level=1),  # too long
        ChapterEntry(title="Fine", page_number=3, level=1),
        ChapterEntry(title="Backwards far", page_number=1, level=1),  # drops below max by > 1
        ChapterEntry(title="Allowed dip", page_number=2, level=2),  # within +/-1 tolerance
        ChapterEntry(title="Forward", page_number=7, level=1),
    ]
    result = validate_chapters(entries, digests)
    titles = [e.title for e in result]
    assert "Out of range" not in titles
    assert all(len(t) <= 200 for t in titles)
    assert "Backwards far" not in titles
    assert "Allowed dip" in titles
    assert "Forward" in titles


def test_validate_without_digests_allows_any_page() -> None:
    entries = [ChapterEntry(title="x", page_number=10_000, level=1)]
    result = validate_chapters(entries, None)
    assert len(result) == 1
