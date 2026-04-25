"""End-to-end integration test against a running server.

Generates a small multi-chapter PDF, uploads it, follows SSE, confirms the
preview, downloads the output, and verifies bookmarks were actually written.
"""
from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def make_test_pdf(path: Path) -> None:
    """A 12-page PDF with a realistic TOC page and three chapter starts."""
    doc = pymupdf.open()
    # page 0 - title
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 200), "A Walnut Story", fontsize=28, fontname="hebo")
    p.insert_text((72, 240), "by Test Author", fontsize=14)
    # page 1 - copyright
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 100), "Copyright 2026", fontsize=10)
    # page 2 - TOC
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 80), "Contents", fontsize=20, fontname="hebo")
    leader = "." * 40
    p.insert_text((72, 130), f"Chapter 1: The Arrival {leader} 4", fontsize=11)
    p.insert_text((72, 160), f"Chapter 2: The Journey {leader} 7", fontsize=11)
    p.insert_text((72, 190), f"Chapter 3: The Return  {leader} 10", fontsize=11)
    # page 3 - chapter 1 starts (printed page 4)
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 100), "Chapter 1: The Arrival", fontsize=18, fontname="hebo")
    p.insert_text((72, 140), "It was a dark and stormy night when our hero arrived.", fontsize=11)
    # page 4 - body
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 100), "More body text for chapter 1.", fontsize=11)
    # page 5 - body
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 100), "Even more body text.", fontsize=11)
    # page 6 - chapter 2 (printed page 7)
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 100), "Chapter 2: The Journey", fontsize=18, fontname="hebo")
    p.insert_text((72, 140), "The road was long and the company strange.", fontsize=11)
    # pages 7-8
    for _ in range(2):
        p = doc.new_page(width=612, height=792)
        p.insert_text((72, 100), "More body text.", fontsize=11)
    # page 9 - chapter 3 (printed page 10)
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 100), "Chapter 3: The Return", fontsize=18, fontname="hebo")
    p.insert_text((72, 140), "All things must come to an end.", fontsize=11)
    # pages 10-11
    for _ in range(2):
        p = doc.new_page(width=612, height=792)
        p.insert_text((72, 100), "Closing pages.", fontsize=11)
    doc.save(path)
    doc.close()


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def post_file(url: str, file_path: Path) -> dict:
    """Multipart upload via stdlib (no requests dep)."""
    boundary = "---------------walnutboundary"
    body = io.BytesIO()
    body.write(f"--{boundary}\r\n".encode())
    body.write(b'Content-Disposition: form-data; name="file"; ')
    body.write(f'filename="{file_path.name}"\r\n'.encode())
    body.write(b"Content-Type: application/pdf\r\n\r\n")
    body.write(file_path.read_bytes())
    body.write(f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        url,
        data=body.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def post_json(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def stream_sse(url: str, max_seconds: float = 60.0):
    """Yield (event, data) tuples from an SSE stream."""
    req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
    deadline = time.monotonic() + max_seconds
    with urllib.request.urlopen(req, timeout=max_seconds) as r:
        event = None
        for raw in r:
            if time.monotonic() > deadline:
                raise TimeoutError("SSE stream timed out")
            line = raw.decode().rstrip("\r\n")
            if not line:
                continue
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = json.loads(line.split(":", 1)[1].strip() or "{}")
                yield event, data
                if event in ("complete", "error"):
                    return
                event = None


def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="walnut-e2e-"))
    pdf_path = workdir / "story.pdf"
    make_test_pdf(pdf_path)
    print(f"[setup] created test PDF at {pdf_path} ({pdf_path.stat().st_size} bytes)")

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "WALNUT_LLM_MODE": "off"}
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "walnut.server:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"{base}/healthz", timeout=1) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(0.1)
        else:
            print("[fail] server never came up")
            return 2
        print(f"[server] running on {base}")

        with urllib.request.urlopen(f"{base}/healthz") as r:
            print(f"[healthz] {r.status} {r.read().decode()[:120]}")

        upload = post_file(f"{base}/upload", pdf_path)
        job_id = upload["job_id"]
        print(f"[upload] job_id={job_id} pages={upload['page_count']}")

        chapters_from_preview = None
        for event, data in stream_sse(f"{base}/jobs/{job_id}/events", max_seconds=30):
            if event == "stage":
                print(f"[stage]   {data}")
            elif event == "preview":
                chapters_from_preview = data["chapters"]
                print(f"[preview] {len(chapters_from_preview)} chapters")
                for c in chapters_from_preview:
                    print(f"          {c}")
                edited = [
                    {"title": c["title"], "page": c["page"], "level": c["level"]}
                    for c in chapters_from_preview
                ]
                post_json(f"{base}/jobs/{job_id}/confirm", {"chapters": edited})
                print(f"[confirm] sent {len(edited)} chapters")
            elif event == "complete":
                print(f"[complete] {data}")
                break
            elif event == "error":
                print(f"[error] {data}")
                return 3

        out_path = workdir / "output.pdf"
        with urllib.request.urlopen(f"{base}{upload.get('download_url', f'/jobs/{job_id}/download')}") as r:
            disposition = r.headers.get("Content-Disposition", "")
            content_type = r.headers.get("Content-Type", "")
            out_path.write_bytes(r.read())
        print(f"[download] {out_path} ({out_path.stat().st_size} bytes)")
        print(f"[download] Content-Type: {content_type}")
        print(f"[download] Content-Disposition: {disposition}")
        assert "walnut-" in disposition, f"filename not walnut-prefixed: {disposition}"

        out_doc = pymupdf.open(out_path)
        toc = out_doc.get_toc(simple=True)
        out_doc.close()
        print(f"[verify] output TOC has {len(toc)} entries:")
        for e in toc:
            print(f"          {e}")
        assert len(toc) >= 3, f"expected >=3 chapters, got {len(toc)}"

        src_size = pdf_path.stat().st_size
        with pdf_path.open("rb") as fa, out_path.open("rb") as fb:
            head_a = fa.read(src_size)
            head_b = fb.read(src_size)
        if head_a == head_b:
            print(f"[verify] byte-prefix preserved (first {src_size} bytes match)")
        else:
            print(f"[verify] byte-prefix NOT preserved (rewrite path used)")

        print()
        print("E2E PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
