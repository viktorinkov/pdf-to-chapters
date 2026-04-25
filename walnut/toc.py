from __future__ import annotations

import re

from walnut.pdf import Chapter, PageDigest, logical_to_physical

# Matches "<title><dot-leader-or-spaces><page-number>" where page-number is
# roman or arabic. The title is non-greedy; the leader must be >= 3 of
# space / dot / ellipsis.
TOC_LINE_RE = re.compile(
    r"^(.+?)[\s.…]{3,}\s*([ivxlcdmIVXLCDM\d]+)\s*$"
)

_DECIMAL_PREFIX_RE = re.compile(r"^(\d+)(?:\.(\d+))+\b")


def find_toc_pages(
    digests: list[PageDigest], window: tuple[int, int] = (0, 25)
) -> list[tuple[int, list[tuple[str, str]]]]:
    out: list[tuple[int, list[tuple[str, str]]]] = []
    for d in digests[window[0] : window[1]]:
        lines = [ln.rstrip() for ln in d.text.splitlines() if ln.strip()]
        if len(lines) < 4:
            continue
        matches = [TOC_LINE_RE.match(ln) for ln in lines]
        hit_ratio = sum(1 for m in matches if m) / max(1, len(lines))
        if hit_ratio >= 0.5:
            entries: list[tuple[str, str]] = [
                (m.group(1).strip(), m.group(2)) for m in matches if m
            ]
            out.append((d.page_idx, entries))
    return out


def _parse_decimal_section(title: str) -> tuple[int, int | None] | None:
    """Return (top, sub) if title starts with '<n>.<m>...'; else None.

    '3.1 Introduction' -> (3, 1). '3 Overview' -> None.
    """
    m = _DECIMAL_PREFIX_RE.match(title.strip())
    if not m:
        return None
    top = int(m.group(1))
    sub = int(m.group(2)) if m.group(2) is not None else None
    return (top, sub)


def _leading_int(title: str) -> int | None:
    """Return the leading integer if the title starts with one (no dot after)."""
    m = re.match(r"^(\d+)(?!\.\d)", title.strip())
    return int(m.group(1)) if m else None


def parse_toc(
    toc_pages: list[tuple[int, list[tuple[str, str]]]],
    page_labels: list[dict],
    n_pages: int,
) -> list[Chapter]:
    """Flatten parsed TOC entries into a nested list of Chapter objects.

    A title like '3.1 Foo' with leading decimal section is treated as a
    level-2 child of the most recent chapter whose leading integer matches
    (3). Otherwise it becomes a top-level chapter.
    """
    chapters: list[Chapter] = []
    # Collate entries across all detected TOC pages, preserving order.
    entries: list[tuple[str, str]] = []
    for _page_idx, ents in toc_pages:
        entries.extend(ents)

    for title, printed in entries:
        phys = logical_to_physical(printed, page_labels, n_pages)
        if phys is None:
            continue
        ch = Chapter(
            title=title,
            physical_page_idx=phys,
            printed_label=printed,
            confidence=1.0,
            children=[],
        )
        decimal = _parse_decimal_section(title)
        if decimal is not None and decimal[1] is not None:
            top = decimal[0]
            parent = None
            # Find most recent top-level chapter whose leading int matches.
            for existing in reversed(chapters):
                if _leading_int(existing.title) == top:
                    parent = existing
                    break
            if parent is not None:
                parent.children.append(ch)
                continue
        chapters.append(ch)
    return chapters
