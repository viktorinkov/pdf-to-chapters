from __future__ import annotations

import math
from typing import Any

from .schemas import ChapterEntry


# Signal weights from docs/quality-evaluation.md. Sum is 1.0.
WEIGHT_LOGPROB = 0.35
WEIGHT_AGREEMENT = 0.30
WEIGHT_HEURISTIC = 0.20
WEIGHT_SELF_CONSISTENCY = 0.15

# Thresholds: see docs/quality-evaluation.md "Thresholds -> UX".
THRESHOLD_CLEAN = 0.85
THRESHOLD_LOW = 0.55

# Heading-heuristic check: titles on page start usually appear in the top 30% of
# the page (see docs/pdf-processing.md "Heading heuristics" #3).
HEADING_TOP_FRACTION = 0.30

# Page-label match tolerance when locating the detected chapter's start page.
PAGE_MATCH_TOLERANCE = 1

MAX_TITLE_LEN = 200


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _logprob_to_prob(logprob: float | None) -> float:
    """Mean token logprob to 0-1 probability.

    Input convention: natural-log probability (<= 0). `exp(logprob)` gives the
    0-1 signal; positive inputs are treated as degenerate certainty and clamped.
    """
    if logprob is None:
        return 0.5  # neutral when signal is absent.
    if logprob >= 0.0:
        return 1.0
    return _clamp(math.exp(logprob))


def _title_similarity(a: str, b: str) -> float:
    """Crude similarity on normalized lowercase tokens; 0 when either side empty."""
    if not a or not b:
        return 0.0
    ta = a.strip().lower()
    tb = b.strip().lower()
    if not ta or not tb:
        return 0.0
    if ta == tb:
        return 1.0
    set_a = set(ta.split())
    set_b = set(tb.split())
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a & set_b)
    union = len(set_a | set_b)
    return inter / union if union else 0.0


def _agreement_score(entry: ChapterEntry, toc_candidates: list[ChapterEntry] | None) -> float:
    """1.0 if an independent TOC candidate matches within +-1 page, similar title; 0.5 when LLM-only."""
    if toc_candidates is None:
        return 0.5  # LLM-only source.
    for candidate in toc_candidates:
        if abs(candidate.page_number - entry.page_number) <= PAGE_MATCH_TOLERANCE:
            sim = _title_similarity(candidate.title, entry.title)
            if sim >= 0.85:
                return 1.0
    # TOC ran but disagreed.
    return 0.0


def _heading_heuristic_score(
    entry: ChapterEntry,
    page_digests: list[Any] | None,
    body_size_p95: float | None,
) -> float:
    """Does the claimed start page actually have a heading-style span near the top?

    Heading = size >= p95 AND in the top 30% of the page. Falls back to 0.0 when
    we cannot locate the page or have no size distribution to compare against.
    """
    if page_digests is None or body_size_p95 is None:
        return 0.0
    target = None
    for d in page_digests:
        # Match printed label first (LLM returns labels, not physical indices).
        label = getattr(d, "page_label", None)
        if label is not None and str(label) == str(entry.page_number):
            target = d
            break
    if target is None:
        # Fallback: try 1-based physical index.
        physical = entry.page_number - 1
        for d in page_digests:
            if getattr(d, "page_idx", None) == physical:
                target = d
                break
    if target is None:
        return 0.0
    spans = getattr(target, "spans", []) or []
    if not spans:
        return 0.0
    max_y = 0.0
    for sp in spans:
        bbox = getattr(sp, "bbox", None)
        if bbox is None:
            continue
        y1 = float(bbox[3])
        if y1 > max_y:
            max_y = y1
    # When we don't know page height, assume the largest seen y1 approximates it
    # -- spans span the whole page in practice.
    page_height = max_y if max_y > 0 else 1.0
    cutoff = page_height * HEADING_TOP_FRACTION
    for sp in spans:
        size = float(getattr(sp, "size", 0.0))
        bbox = getattr(sp, "bbox", None)
        if bbox is None:
            continue
        y0 = float(bbox[1])
        if size >= body_size_p95 and y0 <= cutoff:
            return 1.0
    return 0.0


def score_chapter(
    entry: ChapterEntry,
    *,
    page_digests: list[Any] | None,
    toc_candidates: list[ChapterEntry] | None,
    llm_logprob: float | None,
    self_consistency_hit: bool,
    body_size_p95: float | None,
) -> float:
    """Fuse four calibrated signals (see docs/quality-evaluation.md) into 0-1."""
    logprob_signal = _logprob_to_prob(llm_logprob)
    agreement_signal = _agreement_score(entry, toc_candidates)
    heuristic_signal = _heading_heuristic_score(entry, page_digests, body_size_p95)
    self_consistency_signal = 1.0 if self_consistency_hit else 0.5

    score = (
        WEIGHT_LOGPROB * logprob_signal
        + WEIGHT_AGREEMENT * agreement_signal
        + WEIGHT_HEURISTIC * heuristic_signal
        + WEIGHT_SELF_CONSISTENCY * self_consistency_signal
    )
    return _clamp(score)


def flag_from_score(score: float) -> str | None:
    """Map a confidence score to UI treatment per docs/quality-evaluation.md."""
    if score >= THRESHOLD_CLEAN:
        return None
    if score >= THRESHOLD_LOW:
        return "low_conf"
    return "very_low"


def validate_chapters(
    entries: list[ChapterEntry],
    page_digests: list[Any] | None = None,
) -> list[ChapterEntry]:
    """Drop hallucinations from the LLM output.

    Rules from docs/prompts.md "Failure-handling":
      - Page must be in [1, total_pages].
      - Title length must be <= 200 chars.
      - Sorted ascending by page number; we tolerate equal pages (section within
        chapter) but drop any entry that goes backwards by more than 1 page.
    """
    total_pages: int | None = None
    if page_digests is not None:
        total_pages = len(page_digests)

    # First pass: drop out-of-range pages and overlong titles.
    cleaned: list[ChapterEntry] = []
    for e in entries:
        if len(e.title) > MAX_TITLE_LEN:
            continue
        if e.page_number < 1:
            continue
        if total_pages is not None and e.page_number > total_pages:
            continue
        cleaned.append(e)

    # Second pass: drop monotonic violations. An entry is bad when its page drops
    # more than 1 page below the running max of already-kept entries.
    result: list[ChapterEntry] = []
    max_page = 0
    for e in cleaned:
        if e.page_number + 1 < max_page:
            continue
        result.append(e)
        if e.page_number > max_page:
            max_page = e.page_number
    return result
