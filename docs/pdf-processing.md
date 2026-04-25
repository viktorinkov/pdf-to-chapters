# PDF Processing

Text extraction, TOC parsing, heading heuristics, and outline insertion. As of April 24, 2026.

## Library choices

| Concern | Library | Version | Why |
|---|---|---|---|
| Text + structure extraction | **PyMuPDF** (fitz) | ≥ 1.27.2 | Fastest. `get_text("dict")` returns spans with font, size, flags, bbox. Ships `get_toc()` and `get_page_labels()`. |
| Existing-outline read | **PyMuPDF** | same | `doc.get_toc()` |
| Outline write (primary) | **PyMuPDF** | same | `set_toc()` + `save(incremental=True)` is the only way to byte-preserve the input. |
| Outline write (fallback) | **pikepdf** (libqpdf) | ≥ 10.5.1 | Cleaner nested-tree API; full rewrite (no byte preserve). Used when `is_repaired`. |
| OCR (optional) | **OCRmyPDF** | ≥ 17.4 | Only if user installs the `[ocr]` extra. |
| Validation | **qpdf CLI** | ≥ 12 | `qpdf --check` as external sanity. |

**Note on licensing:** PyMuPDF is AGPL. For the v1 walnut release that's fine (MIT app + AGPL dependency = the combined work is AGPL when distributed). If a future commercial fork is wanted, swap to pikepdf-only and accept the byte-preservation caveat.

## Data model

```python
from dataclasses import dataclass, field
from typing import Literal

@dataclass
class Span:
    text: str
    size: float            # font size in pt
    font: str              # font name (e.g., "Times-Bold")
    flags: int             # bit 4 = serif, bit 16 = bold, bit 1 = italic
    bbox: tuple[float, float, float, float]   # (x0, y0, x1, y1)
    page_idx: int          # 0-based physical
    page_label: str        # printed label e.g. "i", "47"

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
    physical_page_idx: int     # 0-based, what the PDF outline references
    printed_label: str         # "47", "iv", etc.
    confidence: float          # 0.0–1.0
    children: list["Chapter"] = field(default_factory=list)
```

## Extraction pipeline

```python
import pymupdf  # PyMuPDF >= 1.24 imports as "pymupdf"

def inspect_pdf(path: str) -> dict:
    """Cheap up-front check before queueing the job."""
    doc = pymupdf.open(path)
    out = {
        "pages": doc.page_count,
        "encrypted": doc.is_encrypted,
        "needs_password": doc.needs_pass,
        "has_existing_toc": bool(doc.get_toc(simple=True)),
        "page_labels": doc.get_page_labels() or [],
    }
    doc.close()
    return out

def extract_pages(path: str) -> list[PageDigest]:
    doc = pymupdf.open(path)
    page_labels = doc.get_page_labels() or []
    out: list[PageDigest] = []
    for i, page in enumerate(doc):
        label = _resolve_label(page_labels, i) or str(i + 1)
        d = PageDigest(page_idx=i, page_label=label, text=page.get_text("text"))

        # image-only detection: image bbox covers >= 95% of page area + no text
        page_area = abs(page.rect)
        for img in page.get_images(full=True):
            for bbox in page.get_image_rects(img[0]):
                if abs(bbox & page.rect) / page_area >= 0.95 and not d.text.strip():
                    d.is_image_only = True

        for block in page.get_text("dict")["blocks"]:
            if block.get("type", 0) != 0:
                continue
            for line in block["lines"]:
                for sp in line["spans"]:
                    d.spans.append(Span(
                        text=sp["text"],
                        size=round(sp["size"], 2),
                        font=sp["font"],
                        flags=sp["flags"],
                        bbox=tuple(sp["bbox"]),
                        page_idx=i,
                        page_label=label,
                    ))
        out.append(d)
    doc.close()
    return out
```

Page-label resolution (`_resolve_label`) walks the rules from `get_page_labels()` to convert a physical index → printed label. PyMuPDF returns rules as `[{"startpage": int, "prefix": str, "style": "D|R|r|A|a", "firstpagenum": int}, ...]`.

## Heading heuristics

Run against the spans collected in extraction; flag candidates and let the LLM filter false positives. **A candidate scoring ≥ 3 of 8 is sent to the LLM for confirmation.** Empirically this collapses input from a 300-page book to ~50 candidates.

1. **Font size > body_median × 1.30** (body median = mode of all span sizes).
2. **Bold flag set** (`flags & 16`).
3. **Vertical position in top 30% of page** (`bbox[1] < page_height * 0.30`).
4. **Short line** (≤ 80 chars, often ≤ 40).
5. **All-caps or Title Case**.
6. **Regex match** `^(Chapter|Part|Section|Book|Lecture|Day)\s+([\dIVXLCDM]+)\b` — i18n: also `Capítulo`, `Kapitel`, `Chapitre`, `Capitolo`, `第N章`, `فصل`.
7. **Whitespace gap above** ≥ 1.5 × line height.
8. **Distinct font family** vs. body (e.g., `Times-Bold` while body is `Times-Roman`).

## TOC-page detection

Three universal markers of a printed Table of Contents page:

1. **Density of dot-leaders**: lines containing `\.{3,}` or U+2026 followed by digits.
2. **Right-aligned page numbers**: bbox right-edge clusters within ~2 pt of page right margin, rightmost token parses as `int` or roman.
3. **Position**: typically pages 2–20 of the file (skip cover/copyright).

```python
import re

TOC_LINE_RE = re.compile(r"(.+?)[\s.…]{3,}\s*([ivxlcdmIVXLCDM\d]+)\s*$")

def find_toc_pages(digests: list[PageDigest], window=(0, 25)):
    """Return list of (page_idx, parsed_entries) where the page looks like a printed TOC."""
    out = []
    for d in digests[window[0]:window[1]]:
        lines = [ln.rstrip() for ln in d.text.splitlines() if ln.strip()]
        if len(lines) < 4:
            continue
        matches = [TOC_LINE_RE.match(ln) for ln in lines]
        hit_ratio = sum(1 for m in matches if m) / max(1, len(lines))
        if hit_ratio >= 0.5:
            entries = [(m.group(1).strip(), m.group(2)) for m in matches if m]
            out.append((d.page_idx, entries))
    return out
```

When a TOC is found, send only the parsed entries to the LLM for normalization (split chapter vs. sub-section, map printed labels to physical indices). The work is mostly already done by regex.

## Page-number resolution

The LLM returns "logical" / printed page numbers (`"47"`, `"iv"`, `"A-3"`). PDF outlines need 0-based physical indices. Books often have front matter in roman numerals → arabic.

```python
def logical_to_physical(printed: str, page_labels: list[dict], n_pages: int) -> int | None:
    """Return 0-based physical index for a printed label like 'iv', '47', 'A-3'."""
    p = printed.strip()
    for r in page_labels:
        start = r["startpage"]
        first = r.get("firstpagenum", 1)
        style = r.get("style", "D")
        prefix = r.get("prefix", "")
        end = next((s["startpage"] for s in page_labels if s["startpage"] > start), n_pages)
        for idx in range(start, end):
            label = f'{prefix}{_format_label(idx - start + first, style)}'
            if label.lower() == p.lower():
                return idx
    return None
```

Algorithm:
1. Read `doc.get_page_labels()`. If non-empty, use directly.
2. Otherwise heuristic: extract bottom-most/top-most numeric span on each page → build `printed → idx` map → detect offset.
3. For each LLM chapter, look up its label. If missing (off-by-one because chapters often start on a recto that omits its folio), search ±2 pages and pick the first page whose first heading span matches the candidate title.
4. Sanity check: monotonic non-decreasing physical indices across the chapter list.

## Outline insertion (the critical step)

PDF spec **incremental update**: an incremental save *appends* a new objects region + xref + trailer to the file. Bytes 0..N of the original are unchanged. This is the mechanism PDF signers use to avoid invalidating signatures.

```python
import shutil
from pathlib import Path
import pymupdf
import pikepdf

def add_outline(input_path: str, chapters: list[Chapter], output_path: str,
                replace_existing: bool = False) -> None:
    """Write a nested PDF outline. Output is byte-equivalent to input plus an
    appended incremental-update region containing only the new /Outlines and an
    updated /Catalog."""
    src = Path(input_path)
    dst = Path(output_path)
    if dst.exists():
        dst.unlink()
    shutil.copyfile(src, dst)         # byte-for-byte copy

    doc = pymupdf.open(dst)
    if doc.is_encrypted:
        raise WalnutError("ENCRYPTED", "Decrypt first.")
    if doc.is_repaired:
        # Incremental save would be unsafe; fall back to pikepdf rewrite.
        doc.close()
        return _add_outline_pikepdf(src, chapters, dst, replace_existing)

    if doc.get_toc(simple=True) and not replace_existing:
        raise WalnutError("HAS_TOC", "PDF already has a TOC.")

    flat: list[list] = []
    def _walk(items, level):
        for ch in items:
            flat.append([level, ch.title, ch.physical_page_idx + 1])  # set_toc is 1-based
            if ch.children:
                _walk(ch.children, level + 1)
    _walk(chapters, 1)

    doc.set_toc(flat)
    # incremental=True ensures only an appended region is written.
    doc.save(dst, incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
    doc.close()

    _verify_byte_prefix(src, dst)


def _add_outline_pikepdf(src: Path, chapters: list[Chapter], dst: Path,
                         replace_existing: bool) -> None:
    """Fallback. NOT byte-preserving (full rewrite). Used for repaired/encrypted docs
    that PyMuPDF cannot incremental-save."""
    with pikepdf.open(src, allow_overwriting_input=False) as pdf:
        with pdf.open_outline() as outline:
            if replace_existing:
                outline.root.clear()
            elif outline.root:
                raise WalnutError("HAS_TOC", "PDF already has outlines.")
            for ch in chapters:
                outline.root.append(_make_item(pdf, ch))
        pdf.save(
            dst,
            object_stream_mode=pikepdf.ObjectStreamMode.preserve,
            normalize_content=False,
            preserve_pdfa=True,
        )


def _make_item(pdf, ch: Chapter):
    item = pikepdf.OutlineItem(ch.title, ch.physical_page_idx, "FitH")
    for sub in ch.children:
        item.children.append(_make_item(pdf, sub))
    return item


def _verify_byte_prefix(src: Path, dst: Path) -> None:
    """Assert that the first len(src) bytes of dst equal src exactly. Holds iff
    PyMuPDF wrote a true incremental update."""
    src_size = src.stat().st_size
    with src.open("rb") as fa, dst.open("rb") as fb:
        a = fa.read(src_size)
        b = fb.read(src_size)
    if a != b:
        raise RuntimeError("Incremental save did NOT preserve original bytes.")
```

## Edge-case matrix

| Case | Detection | Action |
|---|---|---|
| Already bookmarked | `doc.get_toc()` non-empty | Skip (default) or replace if `replace_existing=True` |
| Encrypted (no password) | `doc.is_encrypted and doc.needs_pass` | Reject with `ENCRYPTED` error |
| Encrypted (owner-pw, user empty) | `doc.is_encrypted and not doc.needs_pass` | Authenticate empty pw; proceed |
| Image-only / scanned | Per-page `text.strip() == "" and img bbox ≥ 95% of page` | Reject with `NO_TEXT`; suggest `ocrmypdf` |
| Mixed (some pages scanned) | Per-page check above | If [ocr] extra installed: `ocrmypdf --force-ocr` only on bare pages, then restart pipeline |
| Repair on open | `doc.is_repaired == True` | Fall back to pikepdf (lose byte-equivalence) |
| Corrupted (won't open) | Both libraries raise | Try `qpdf --check`; if fixable, `qpdf --object-streams=preserve in.pdf fixed.pdf` then retry |
| Linearized (web-optimized) | `pikepdf.Pdf.is_linearized` | Incremental save de-linearizes slightly; acceptable |
| Signed PDF | `/Catalog/AcroForm/SigFlags` bit 1 | **Must** use incremental save to avoid signature breakage; PyMuPDF path is correct |
| Tagged PDF (accessibility) | `/Catalog/MarkInfo/Marked == true` | No special handling |
| Custom-style page labels | `get_page_labels()` returns custom prefix | Use `_format_label()` exactly |

## Validation

```python
def validate_output(output_path: str, expected: list[Chapter]) -> None:
    # 1. pikepdf round-trip + warnings.
    with pikepdf.open(output_path) as pdf:
        with pdf.open_outline() as outline:
            roots = list(outline.root)
            assert len(roots) == len(expected)
        warns = pdf.get_warnings()
        assert not warns, f"pikepdf warnings: {warns}"

    # 2. qpdf --check.
    import subprocess
    res = subprocess.run(["qpdf", "--check", output_path], capture_output=True, text=True)
    assert res.returncode in (0, 3), f"qpdf failed:\n{res.stdout}\n{res.stderr}"

    # 3. PyMuPDF re-read of the TOC.
    doc = pymupdf.open(output_path)
    toc = doc.get_toc(simple=True)
    assert len(toc) >= len(expected)
    doc.close()

    # 4. Byte-prefix invariant. Done inside add_outline() via _verify_byte_prefix.
```

Smoke-test in two viewers: Acrobat / Preview / a Chromium PDF viewer. Different viewers handle `/Dest` arrays differently; testing two confirms portability.

## Sources

- https://pymupdf.readthedocs.io/en/latest/changes.html
- https://pymupdf.readthedocs.io/en/latest/document.html
- https://github.com/pymupdf/PyMuPDF/wiki/Using-Incremental-Saves
- https://pikepdf.readthedocs.io/en/latest/topics/outlines.html
- https://qpdf.readthedocs.io/en/stable/json.html
- https://developers.foxit.com/developer-hub/document/incremental-updates/
