from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pikepdf
import pymupdf

from walnut.errors import ENCRYPTED, HAS_TOC, WalnutError


@dataclass
class Span:
    text: str
    size: float
    font: str
    flags: int
    bbox: tuple[float, float, float, float]
    page_idx: int
    page_label: str


@dataclass
class PageDigest:
    page_idx: int
    page_label: str
    text: str
    spans: list[Span] = field(default_factory=list)
    is_image_only: bool = False


@dataclass
class Chapter:
    title: str
    physical_page_idx: int
    printed_label: str
    confidence: float
    children: list["Chapter"] = field(default_factory=list)


_ROMAN_PAIRS: tuple[tuple[int, str], ...] = (
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
    (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
    (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
)


def _int_to_roman(n: int) -> str:
    if n <= 0:
        return ""
    out: list[str] = []
    for value, sym in _ROMAN_PAIRS:
        while n >= value:
            out.append(sym)
            n -= value
    return "".join(out)


def _int_to_alpha(n: int) -> str:
    """Spreadsheet-style alphabetic labels: 1='A', 27='AA', 28='AB'."""
    if n <= 0:
        return ""
    out: list[str] = []
    while n > 0:
        n, rem = divmod(n - 1, 26)
        out.append(chr(ord("A") + rem))
    return "".join(reversed(out))


def _format_label(n: int, style: str) -> str:
    match style:
        case "D" | "":
            return str(n)
        case "R":
            return _int_to_roman(n)
        case "r":
            return _int_to_roman(n).lower()
        case "A":
            return _int_to_alpha(n)
        case "a":
            return _int_to_alpha(n).lower()
        case _:
            return str(n)


def _resolve_label(page_labels: list[dict], idx: int) -> str | None:
    if not page_labels:
        return None
    # Find rule whose startpage <= idx (highest such startpage).
    applicable = None
    for rule in page_labels:
        if rule.get("startpage", 0) <= idx:
            if applicable is None or rule["startpage"] > applicable["startpage"]:
                applicable = rule
    if applicable is None:
        return None
    first = applicable.get("firstpagenum", 1)
    style = applicable.get("style", "D")
    prefix = applicable.get("prefix", "")
    n = idx - applicable["startpage"] + first
    return f"{prefix}{_format_label(n, style)}"


def inspect_pdf(path: str) -> dict:
    doc = pymupdf.open(path)
    try:
        out = {
            "pages": doc.page_count,
            "encrypted": doc.is_encrypted,
            "needs_password": doc.needs_pass,
            "has_existing_toc": bool(doc.get_toc(simple=True)),
            "page_labels": doc.get_page_labels() or [],
        }
    finally:
        doc.close()
    return out


def extract_pages(path: str) -> list[PageDigest]:
    doc = pymupdf.open(path)
    try:
        page_labels = doc.get_page_labels() or []
        out: list[PageDigest] = []
        for i, page in enumerate(doc):
            label = _resolve_label(page_labels, i) or str(i + 1)
            text = page.get_text("text")
            d = PageDigest(page_idx=i, page_label=label, text=text)

            page_area = abs(page.rect)
            if page_area > 0:
                for img in page.get_images(full=True):
                    for bbox in page.get_image_rects(img[0]):
                        if abs(bbox & page.rect) / page_area >= 0.95 and not d.text.strip():
                            d.is_image_only = True

            for block in page.get_text("dict")["blocks"]:
                if block.get("type", 0) != 0:
                    continue
                for line in block["lines"]:
                    for sp in line["spans"]:
                        d.spans.append(
                            Span(
                                text=sp["text"],
                                size=round(sp["size"], 2),
                                font=sp["font"],
                                flags=sp["flags"],
                                bbox=tuple(sp["bbox"]),
                                page_idx=i,
                                page_label=label,
                            )
                        )
            out.append(d)
    finally:
        doc.close()
    return out


def logical_to_physical(printed: str, page_labels: list[dict], n_pages: int) -> int | None:
    p = printed.strip()
    if not page_labels:
        # Default: printed labels equal 1-based physical page numbers.
        try:
            n = int(p)
        except ValueError:
            return None
        if 1 <= n <= n_pages:
            return n - 1
        return None

    for r in page_labels:
        start = r["startpage"]
        first = r.get("firstpagenum", 1)
        style = r.get("style", "D")
        prefix = r.get("prefix", "")
        end = next(
            (s["startpage"] for s in page_labels if s["startpage"] > start), n_pages
        )
        for idx in range(start, end):
            label = f"{prefix}{_format_label(idx - start + first, style)}"
            if label.lower() == p.lower():
                return idx
    return None


def _verify_byte_prefix(src: Path, dst: Path) -> None:
    src_size = src.stat().st_size
    with src.open("rb") as fa, dst.open("rb") as fb:
        a = fa.read(src_size)
        b = fb.read(src_size)
    if a != b:
        raise RuntimeError("Incremental save did NOT preserve original bytes.")


def _make_pike_item(ch: Chapter) -> pikepdf.OutlineItem:
    item = pikepdf.OutlineItem(ch.title, ch.physical_page_idx, "FitH")
    for sub in ch.children:
        item.children.append(_make_pike_item(sub))
    return item


def _add_outline_pikepdf(
    src: Path, chapters: list[Chapter], dst: Path, replace_existing: bool
) -> None:
    with pikepdf.open(src, allow_overwriting_input=False) as pdf:
        with pdf.open_outline() as outline:
            if replace_existing:
                outline.root.clear()
            elif outline.root:
                raise WalnutError(HAS_TOC, "PDF already has outlines.")
            for ch in chapters:
                outline.root.append(_make_pike_item(ch))
        pdf.save(
            dst,
            object_stream_mode=pikepdf.ObjectStreamMode.preserve,
            normalize_content=False,
            preserve_pdfa=True,
        )


def add_outline(
    input_path: str,
    chapters: list[Chapter],
    output_path: str,
    replace_existing: bool = False,
) -> None:
    src = Path(input_path)
    dst = Path(output_path)
    if dst.exists():
        dst.unlink()
    shutil.copyfile(src, dst)

    doc = pymupdf.open(dst)
    try:
        if doc.is_encrypted:
            raise WalnutError(ENCRYPTED, "Decrypt first.")
        if doc.is_repaired:
            doc.close()
            _add_outline_pikepdf(src, chapters, dst, replace_existing)
            return

        if doc.get_toc(simple=True) and not replace_existing:
            raise WalnutError(HAS_TOC, "PDF already has a TOC.")

        flat: list[list] = []

        def _walk(items: list[Chapter], level: int) -> None:
            for ch in items:
                flat.append([level, ch.title, ch.physical_page_idx + 1])
                if ch.children:
                    _walk(ch.children, level + 1)

        _walk(chapters, 1)

        doc.set_toc(flat)
        doc.save(str(dst), incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
    finally:
        doc.close()

    _verify_byte_prefix(src, dst)


def validate_output(output_path: str, expected: list[Chapter]) -> None:
    with pikepdf.open(output_path) as pdf:
        with pdf.open_outline() as outline:
            roots = list(outline.root)
            if len(roots) != len(expected):
                raise AssertionError(
                    f"outline root count {len(roots)} != expected {len(expected)}"
                )
        warns = pdf.get_warnings()
        if warns:
            raise AssertionError(f"pikepdf warnings: {warns}")

    try:
        res = subprocess.run(
            ["qpdf", "--check", output_path], capture_output=True, text=True
        )
    except FileNotFoundError:
        res = None
    if res is not None and res.returncode not in (0, 3):
        raise AssertionError(f"qpdf failed:\n{res.stdout}\n{res.stderr}")

    doc = pymupdf.open(output_path)
    try:
        toc = doc.get_toc(simple=True)
        if len(toc) < len(expected):
            raise AssertionError(f"toc len {len(toc)} < expected {len(expected)}")
    finally:
        doc.close()
