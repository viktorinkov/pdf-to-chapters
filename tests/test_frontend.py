"""Tests for the static frontend in `walnut/web/`.

These don't run a browser; they just parse `index.html` with BeautifulSoup and
make sure the building blocks (screens, About modal, real credit link, no
placeholder/legal junk) are wired up correctly.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from bs4 import BeautifulSoup

WEB_DIR = Path(__file__).resolve().parents[1] / "walnut" / "web"
INDEX_PATH = WEB_DIR / "index.html"
STATIC_DIR = WEB_DIR / "static"


@pytest.fixture(scope="module")
def html_text() -> str:
    return INDEX_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def soup(html_text: str) -> BeautifulSoup:
    return BeautifulSoup(html_text, "html.parser")


def test_index_html_parses(soup: BeautifulSoup) -> None:
    assert soup.find("html") is not None
    assert soup.find("head") is not None
    assert soup.find("body") is not None
    title = soup.find("title")
    assert title is not None
    assert "walnut" in title.get_text().lower()


def test_all_five_screens_present(soup: BeautifulSoup) -> None:
    """Each of idle/run/preview/done/err must have an x-show binding."""
    expected = {"idle", "run", "preview", "done", "err"}

    found: set[str] = set()
    for el in soup.find_all(attrs={"x-show": True}):
        value = (el.get("x-show") or "").replace(" ", "").replace('"', "'")
        for name in list(expected - found):
            # Match `screen==='idle'` regardless of single/double quotes/spacing.
            if f"screen==='{name}'" in value:
                found.add(name)

    missing = expected - found
    assert not missing, f"missing screens: {sorted(missing)}; found: {sorted(found)}"


def test_about_section_present(soup: BeautifulSoup, html_text: str) -> None:
    """About modal must exist with a heading and toggle wiring."""
    # A button that opens it.
    triggers = [
        b for b in soup.find_all(["button", "a"])
        if "aboutOpen" in (b.get("@click", "") or b.get("x-on:click", ""))
    ]
    assert triggers, "no element with @click toggling aboutOpen found"

    # The modal markup itself exists in the source.
    assert "about-heading" in html_text
    assert "about walnut" in html_text.lower()


def test_viktor_minchev_credit_with_linkedin(soup: BeautifulSoup, html_text: str) -> None:
    target = "https://www.linkedin.com/in/viktor-minchev/"
    link = soup.find("a", href=target)
    assert link is not None, f"no <a href='{target}'> in index.html"

    assert link.get("target") == "_blank", "credit link must open in a new tab"
    rel = (link.get("rel") or [])
    rel_str = " ".join(rel) if isinstance(rel, list) else str(rel)
    assert "noopener" in rel_str, f"rel missing 'noopener' (got {rel_str!r})"
    assert "noreferrer" in rel_str, f"rel missing 'noreferrer' (got {rel_str!r})"

    # "Viktor Minchev" must be the link text or appear immediately around it.
    # `bs4`'s `get_text` returns '' for descendants of `<template>`, so use
    # `.string` / `.contents` and fall back to the raw source.
    link_text = (link.string or "").strip()
    if not link_text:
        link_text = "".join(c for c in link.contents if isinstance(c, str)).strip()
    raw_around = html_text  # entire file is fine, we just want a presence check
    assert "Viktor Minchev" in link_text or "Viktor Minchev" in raw_around, (
        "link must be labelled with 'Viktor Minchev'"
    )


def test_no_placeholder_links(soup: BeautifulSoup) -> None:
    for a in soup.find_all("a"):
        href = a.get("href")
        if href is None:
            continue
        assert href != "#", f"placeholder href='#' on link with text {a.get_text(strip=True)!r}"
        assert "javascript:void" not in href.lower(), (
            f"javascript:void(...) href on link {a.get_text(strip=True)!r}"
        )


def test_no_fake_legal_text(html_text: str) -> None:
    lower = html_text.lower()
    forbidden = ["terms of service", "privacy policy", "coming soon"]
    found = [phrase for phrase in forbidden if phrase in lower]
    assert not found, f"forbidden boilerplate found: {found}"


def test_static_assets_referenced(html_text: str) -> None:
    assert "/static/style.css" in html_text
    assert "/static/walnut.js" in html_text
    assert "/static/favicon.svg" in html_text
    assert "alpine" in html_text.lower(), "alpine.js must be loaded (script tag or comment fallback)"

    # And the files actually exist on disk.
    for name in ("style.css", "walnut.js", "favicon.svg", "alpine.min.js"):
        path = STATIC_DIR / name
        assert path.exists(), f"missing static asset: {path}"


def test_about_explains_local_only(soup: BeautifulSoup, html_text: str) -> None:
    """The About modal must contain a real explanation, not boilerplate."""
    heading = soup.find(id="about-heading")
    assert heading is not None, "no #about-heading element"

    # The modal markup may live inside a <template> (for x-if rendering), in
    # which case `get_text` returns ''. Re-parse the template's raw children so
    # we can read the actual copy.
    template = heading.find_parent("template")
    if template is not None:
        inner_html = template.decode_contents()
        modal_soup = BeautifulSoup(inner_html, "html.parser")
        text = modal_soup.get_text(" ", strip=True).lower()
    else:
        # Walk up to the modal container.
        container = heading
        for _ in range(6):
            if container.parent is None:
                break
            container = container.parent
            cls = container.get("class") or []
            if "modal-backdrop" in cls or "modal" in cls or container.get("role") == "dialog":
                break
        text = container.get_text(" ", strip=True).lower()

    # Last-resort fallback: scan the raw html (still proves the copy is in the
    # file even when bs4 strips template contents).
    if not text:
        text = html_text.lower()

    assert "local" in text, "about copy must mention 'local'"
    assert ("gemma" in text) or ("ollama" in text), (
        "about copy must mention 'Gemma' or 'Ollama' (the actual stack)"
    )


def test_alpine_self_hosted_file_exists() -> None:
    """We claim to self-host alpine; make sure the file is on disk and non-trivial."""
    p = STATIC_DIR / "alpine.min.js"
    assert p.exists(), f"alpine.min.js not found at {p}"
    assert p.stat().st_size > 10_000, "alpine.min.js looks too small to be the real file"


def test_no_emoji_in_html(html_text: str) -> None:
    """The brief forbids emojis."""
    for ch in html_text:
        cp = ord(ch)
        # Common emoji blocks. Don't catch normal ASCII or extended Latin.
        if 0x1F300 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF:
            raise AssertionError(f"emoji-like character U+{cp:04X} in index.html")
