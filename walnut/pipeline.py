from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any

from walnut.confidence import flag_from_score, score_chapter, validate_chapters
from walnut.errors import (
    CANCELLED,
    ENCRYPTED,
    INVALID_PDF,
    NO_CHAPTERS,
    NO_TEXT,
    OLLAMA_DOWN,
    WalnutError,
)
from walnut.llm import (
    DEFAULT_MODEL,
    OllamaClient,
    annotate,
    detect_chapters_from_toc,
    detect_chapters_fulltext,
)
from walnut.pdf import (
    Chapter,
    PageDigest,
    add_outline,
    extract_pages,
    inspect_pdf,
    logical_to_physical,
)
from walnut.queue import Job
from walnut.schemas import ChapterEntry
from walnut.toc import find_toc_pages, parse_toc

logger = logging.getLogger(__name__)

EmitFn = Callable[[Job, str, dict[str, Any]], Awaitable[None]]

_default_client: OllamaClient | None = None


def _get_default_client() -> OllamaClient:
    global _default_client
    if _default_client is None:
        _default_client = OllamaClient()
    return _default_client


def reset_default_client() -> None:
    """For tests: clear the lazy singleton so an env-overriding test can re-init."""
    global _default_client
    _default_client = None


def _check_cancel(job: Job) -> None:
    if job.cancel.is_set():
        raise WalnutError(CANCELLED, "cancelled")


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1)))))
    return s[k]


def _font_stats(digests: list[PageDigest]) -> tuple[float, float, float, float]:
    """Return p50, p90, p95, p99 over span sizes."""
    sizes: list[float] = []
    for d in digests:
        for sp in d.spans:
            sizes.append(float(sp.size))
    return (
        _percentile(sizes, 50),
        _percentile(sizes, 90),
        _percentile(sizes, 95),
        _percentile(sizes, 99),
    )


def _heading_candidate_text(digests: list[PageDigest], p90: float) -> str:
    """Pick pages with at least one large heading-style span near the top, then
    annotate. This is a coarse heuristic to keep the LLM prompt small.
    """
    parts: list[str] = []
    for d in digests:
        for sp in d.spans:
            # Top of page: y0 is the second bbox value.
            if float(sp.size) >= p90 and float(sp.bbox[1]) <= 250.0:
                parts.append(annotate(d))
                break
    return "\n".join(parts) if parts else "\n".join(annotate(d) for d in digests[:25])


def _entries_to_chapters(
    entries: list[ChapterEntry],
    page_labels: list[dict[str, Any]],
    n_pages: int,
) -> list[Chapter]:
    """Map LLM/TOC entries to physical Chapter objects, dropping unresolvable pages."""
    chapters: list[Chapter] = []
    for e in entries:
        printed = str(e.page_number)
        phys = logical_to_physical(printed, page_labels, n_pages)
        if phys is None:
            # Fallback: 1-based index if it fits.
            if 1 <= e.page_number <= n_pages:
                phys = e.page_number - 1
            else:
                continue
        chapters.append(
            Chapter(
                title=e.title,
                physical_page_idx=phys,
                printed_label=printed,
                confidence=0.0,
            )
        )
    return chapters


def _flatten_chapters_for_score(chapters: list[Chapter]) -> list[Chapter]:
    out: list[Chapter] = []
    for c in chapters:
        out.append(c)
        if c.children:
            out.extend(_flatten_chapters_for_score(c.children))
    return out


def _chapter_to_dict(c: Chapter, *, level: int = 1, idx: int = 0) -> dict[str, Any]:
    """Serialize a Chapter (including children) for the SSE preview payload."""
    flag = flag_from_score(c.confidence)
    out: dict[str, Any] = {
        "id": f"c{idx}",
        "title": c.title,
        "page": c.physical_page_idx + 1,
        "printed_label": c.printed_label,
        "level": level,
        "confidence": c.confidence,
    }
    if flag is not None:
        out["flag"] = flag
    if c.children:
        children_out: list[dict[str, Any]] = []
        for ci, child in enumerate(c.children):
            children_out.append(_chapter_to_dict(child, level=level + 1, idx=ci))
        out["children"] = children_out
    return out


def _chapters_payload(chapters: list[Chapter]) -> list[dict[str, Any]]:
    return [_chapter_to_dict(c, level=1, idx=i) for i, c in enumerate(chapters)]


def _chapters_from_payload(
    payload: list[dict[str, Any]],
    page_labels: list[dict[str, Any]],
    n_pages: int,
) -> list[Chapter]:
    """Inverse of _chapters_payload, used after user confirmation."""
    out: list[Chapter] = []
    for entry in payload:
        title = str(entry.get("title", "")).strip()
        if not title:
            continue
        page_val = entry.get("page")
        try:
            page_num = int(page_val)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if page_num < 1 or page_num > n_pages:
            continue
        # Use printed_label if supplied, else fall back to the 1-based page.
        printed_label = str(entry.get("printed_label") or page_num)
        phys = logical_to_physical(printed_label, page_labels, n_pages)
        if phys is None:
            phys = page_num - 1
        ch = Chapter(
            title=title[:200],
            physical_page_idx=phys,
            printed_label=printed_label,
            confidence=float(entry.get("confidence", 1.0)),
        )
        children_in = entry.get("children") or []
        if isinstance(children_in, list) and children_in:
            ch.children = _chapters_from_payload(children_in, page_labels, n_pages)
        out.append(ch)
    return out


async def _wait_for_confirmation(job: Job) -> None:
    """Block until either confirmed or cancelled. Raise on cancel."""
    confirm_task = asyncio.create_task(job.awaiting_confirmation.wait())
    cancel_task = asyncio.create_task(job.cancel.wait())
    try:
        done, _ = await asyncio.wait(
            {confirm_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        for t in (confirm_task, cancel_task):
            if not t.done():
                t.cancel()
    if job.cancel.is_set():
        raise WalnutError(CANCELLED, "cancelled")


async def process_pdf(
    job: Job,
    on_progress: EmitFn,
    *,
    ollama_client: OllamaClient | None = None,
) -> None:
    """Run the full pipeline for one job. Errors are propagated to the JobManager."""
    try:
        await _process_pdf_inner(job, on_progress, ollama_client=ollama_client)
    except WalnutError:
        raise
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("pipeline error in job %s", job.id)
        raise


async def _process_pdf_inner(
    job: Job,
    on_progress: EmitFn,
    *,
    ollama_client: OllamaClient | None = None,
) -> None:
    llm_mode = os.getenv("WALNUT_LLM_MODE", "on").lower()

    # ---- inspect ---------------------------------------------------------
    await on_progress(job, "stage", {"stage": "inspect"})
    _check_cancel(job)
    try:
        info = inspect_pdf(job.src_path)
    except WalnutError:
        raise
    except Exception as e:  # noqa: BLE001
        msg = str(e).lower()
        if "encrypt" in msg or "password" in msg:
            raise WalnutError(ENCRYPTED, "PDF is password-protected.") from e
        raise WalnutError(INVALID_PDF, f"could not open pdf: {e}") from e
    if info.get("encrypted") and info.get("needs_password"):
        raise WalnutError(ENCRYPTED, "PDF is password-protected.")

    n_pages = int(info.get("pages", 0))
    page_labels = info.get("page_labels", []) or []

    # ---- extract --------------------------------------------------------
    digests = extract_pages(job.src_path)
    total = len(digests) or n_pages
    # Emit progress every 10 pages or on the last page.
    for i, _d in enumerate(digests):
        page_num = i + 1
        if page_num == 1 or page_num == total or page_num % 10 == 0:
            await on_progress(job, "stage", {"stage": "extract", "page": page_num, "total": total})
            _check_cancel(job)
    if digests and all(getattr(d, "is_image_only", False) for d in digests):
        raise WalnutError(NO_TEXT, "PDF appears to be scanned (no extractable text).")
    # If digests is empty but there are pages, treat as no-text.
    if not digests and n_pages > 0:
        raise WalnutError(NO_TEXT, "PDF has no extractable text.")
    # Even when not all-image: if no page has any text at all, treat as NO_TEXT.
    if digests and not any((d.text or "").strip() for d in digests):
        raise WalnutError(NO_TEXT, "PDF has no extractable text on any page.")

    # ---- toc ------------------------------------------------------------
    toc_hits = find_toc_pages(digests)
    toc_chapters: list[Chapter] = []
    if toc_hits:
        toc_chapters = parse_toc(toc_hits, page_labels=page_labels, n_pages=n_pages or total)
    await on_progress(job, "stage", {"stage": "toc", "found": bool(toc_chapters)})
    _check_cancel(job)

    p50, p90, _p95, p99 = _font_stats(digests)
    body_p95 = _percentile([float(s.size) for d in digests for s in d.spans], 95)

    # ---- decide pipeline -----------------------------------------------
    chapters: list[Chapter] = []
    llm_entries: list[ChapterEntry] = []
    if llm_mode == "off":
        if toc_chapters:
            chapters = toc_chapters
            for c in _flatten_chapters_for_score(chapters):
                c.confidence = 1.0
        # else: leave empty, will hit NO_CHAPTERS below.
    else:
        client = ollama_client or _get_default_client()

        # Sanity-check that Ollama is up before we bother building a prompt.
        try:
            reachable = await client.is_reachable()
        except Exception:  # noqa: BLE001
            reachable = False
        if not reachable:
            raise WalnutError(OLLAMA_DOWN, "Cannot reach Ollama on localhost:11434.")

        if toc_chapters:
            # Normalize TOC text via the LLM for clean titles + level inference.
            toc_text_lines: list[str] = []
            for _pi, ents in toc_hits:
                for title, printed in ents:
                    toc_text_lines.append(f"{title} ........ {printed}")
            toc_text = "\n".join(toc_text_lines)
            await on_progress(
                job,
                "stage",
                {"stage": "llm", "tokens_in": max(1, len(toc_text) // 4)},
            )
            _check_cancel(job)
            try:
                result = await detect_chapters_from_toc(
                    client,
                    toc_text=toc_text,
                    lang="en",
                    p50=p50 or 11.0,
                    p90=p90 or 14.0,
                    p99=p99 or 18.0,
                    model=DEFAULT_MODEL,
                )
            except Exception as e:  # noqa: BLE001
                # If LLM fails, fall back to the raw TOC parse.
                logger.warning("llm normalization failed: %s; falling back to TOC parse", e)
                chapters = toc_chapters
                llm_entries = []
            else:
                llm_entries = result.chapters
        else:
            annotated = _heading_candidate_text(digests, p90 or 14.0)
            await on_progress(
                job,
                "stage",
                {"stage": "llm", "tokens_in": max(1, len(annotated) // 4)},
            )
            _check_cancel(job)
            try:
                result = await detect_chapters_fulltext(
                    client,
                    annotated_text=annotated,
                    lang="en",
                    p50=p50 or 11.0,
                    p90=p90 or 14.0,
                    p99=p99 or 18.0,
                    model=DEFAULT_MODEL,
                )
            except Exception as e:  # noqa: BLE001
                raise WalnutError(NO_CHAPTERS, f"LLM failed: {e}") from e
            llm_entries = result.chapters

        if llm_entries:
            cleaned = validate_chapters(llm_entries, digests)
            chapters = _entries_to_chapters(cleaned, page_labels, n_pages or total)

    # ---- score ----------------------------------------------------------
    await on_progress(job, "stage", {"stage": "score"})
    _check_cancel(job)

    # Build TOC candidates for agreement signal (if both pipelines ran).
    toc_entries_for_score: list[ChapterEntry] = []
    for c in _flatten_chapters_for_score(toc_chapters):
        try:
            page_num = c.physical_page_idx + 1
            toc_entries_for_score.append(
                ChapterEntry(title=c.title[:200], page_number=max(1, page_num), level=1)
            )
        except Exception:  # noqa: BLE001
            continue

    flat = _flatten_chapters_for_score(chapters)
    for c in flat:
        # Preserve any pre-existing confidence (e.g. TOC-only mode sets 1.0).
        base = c.confidence if c.confidence and c.confidence > 0 else 0.0
        try:
            entry = ChapterEntry(
                title=c.title[:200] or "untitled",
                page_number=max(1, c.physical_page_idx + 1),
                level=1,
            )
        except Exception:  # noqa: BLE001
            c.confidence = base
            continue
        score = score_chapter(
            entry,
            page_digests=digests,
            toc_candidates=toc_entries_for_score if toc_entries_for_score else None,
            llm_logprob=None,
            self_consistency_hit=False,
            body_size_p95=body_p95 or None,
        )
        # Combine with any pre-existing confidence by taking the max.
        c.confidence = max(base, score)

    if not chapters:
        raise WalnutError(NO_CHAPTERS, "no chapters detected.")

    job.chapters = chapters

    # ---- preview --------------------------------------------------------
    payload = _chapters_payload(chapters)
    await on_progress(job, "preview", {"chapters": payload})
    job.status = "awaiting_confirmation"
    _check_cancel(job)

    await _wait_for_confirmation(job)

    # ---- write ----------------------------------------------------------
    job.status = "writing"
    await on_progress(job, "stage", {"stage": "write"})
    _check_cancel(job)

    confirmed_payload = job.confirmed_chapters or payload
    final_chapters = _chapters_from_payload(
        confirmed_payload, page_labels, n_pages or total
    )
    if not final_chapters:
        raise WalnutError(NO_CHAPTERS, "no chapters in confirmation payload.")

    try:
        add_outline(job.src_path, final_chapters, job.out_path, replace_existing=True)
    except WalnutError:
        raise
    except Exception as e:  # noqa: BLE001
        raise WalnutError(INVALID_PDF, f"could not write outline: {e}") from e

    # ---- complete -------------------------------------------------------
    job.status = "complete"
    await on_progress(
        job,
        "complete",
        {"download_url": f"/jobs/{job.id}/download", "chapters": len(final_chapters)},
    )
