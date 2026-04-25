from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import pytest
import respx

from walnut import server as server_mod
from walnut.llm import OLLAMA_BASE_URL


@pytest.fixture
def tmp_walnut_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(server_mod, "TMP_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
async def client(tmp_walnut_dir: Path) -> AsyncIterator[httpx.AsyncClient]:
    app = server_mod.create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        # Trigger lifespan by hitting any endpoint? Actually httpx ASGITransport
        # doesn't run lifespan by default. We'll set state manually for tests
        # that don't use the worker, and start a JobManager for those that do.
        from walnut.queue import JobManager
        jm = JobManager()
        jm.start()
        app.state.job_manager = jm
        try:
            yield c
        finally:
            await jm.stop()


@pytest.mark.asyncio
async def test_upload_with_pdf_returns_202(client: httpx.AsyncClient, fixture_pdf: Path) -> None:
    with fixture_pdf.open("rb") as f:
        files = {"file": ("the-trial.pdf", f, "application/pdf")}
        resp = await client.post("/upload", files=files)
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert "job_id" in body
    assert body["filename"] == "the-trial.pdf"
    assert body["page_count"] >= 1
    assert body["encrypted"] is False
    assert "size_bytes" in body
    assert body["size_bytes"] > 0


@pytest.mark.asyncio
async def test_upload_rejects_non_pdf_extension(client: httpx.AsyncClient) -> None:
    files = {"file": ("foo.txt", b"hello", "text/plain")}
    resp = await client.post("/upload", files=files)
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]["code"] == "only_pdf"


@pytest.mark.asyncio
async def test_upload_rejects_bad_magic_bytes(client: httpx.AsyncClient) -> None:
    files = {"file": ("foo.pdf", b"not really a pdf", "application/pdf")}
    resp = await client.post("/upload", files=files)
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]["code"] == "only_pdf"


@pytest.mark.asyncio
async def test_upload_too_large(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, fixture_pdf: Path) -> None:
    # Cap at 1 byte so any real PDF blows past it.
    monkeypatch.setattr(server_mod, "WALNUT_MAX_BYTES", 1)
    with fixture_pdf.open("rb") as f:
        files = {"file": ("foo.pdf", f, "application/pdf")}
        resp = await client.post("/upload", files=files)
    assert resp.status_code == 413
    body = resp.json()
    assert body["detail"]["code"] == "TOO_LARGE"


@pytest.mark.asyncio
async def test_filename_sanitization_strips_path_seps(client: httpx.AsyncClient, fixture_pdf: Path) -> None:
    with fixture_pdf.open("rb") as f:
        files = {"file": ("../etc/passwd.pdf", f, "application/pdf")}
        resp = await client.post("/upload", files=files)
    assert resp.status_code == 202
    body = resp.json()
    assert body["filename"] == "passwd.pdf"


@pytest.mark.asyncio
async def test_walnut_prefix_not_doubled(client: httpx.AsyncClient, fixture_pdf: Path) -> None:
    with fixture_pdf.open("rb") as f:
        files = {"file": ("walnut-foo.pdf", f, "application/pdf")}
        resp = await client.post("/upload", files=files)
    assert resp.status_code == 202
    body = resp.json()
    job_id = body["job_id"]
    # The output path on disk shouldn't start with `walnut-walnut-`.
    jm = client._transport.app.state.job_manager  # type: ignore[attr-defined]
    job = jm.get(job_id)
    assert job is not None
    assert "walnut-walnut-" not in job.out_path
    assert job.out_path.endswith("walnut-foo.pdf")


@pytest.mark.asyncio
async def test_healthz_with_llm_off(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WALNUT_LLM_MODE", "off")
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True


@pytest.mark.asyncio
async def test_healthz_ollama_unreachable(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WALNUT_LLM_MODE", "on")

    async def _raise(*args: Any, **kwargs: Any) -> Any:
        raise httpx.ConnectError("nope")

    # Patch the OllamaClient's is_reachable to fail.
    monkeypatch.setattr("walnut.llm.OllamaClient.is_reachable", lambda self: _is_reachable_false(self))

    resp = await client.get("/healthz")
    assert resp.status_code == 503
    body = resp.json()
    assert body["ok"] is False


async def _is_reachable_false(self: Any) -> bool:
    return False


@pytest.mark.asyncio
async def test_sse_emits_stages(tmp_walnut_dir: Path) -> None:
    """Mock the pipeline stages; subscribe; verify events streamed."""
    from walnut.queue import Job, JobManager

    captured: list[dict[str, Any]] = []

    async def fake_pipeline(job: Job, on_progress: Any) -> None:
        await on_progress(job, "stage", {"stage": "inspect"})
        await on_progress(job, "stage", {"stage": "extract", "page": 10, "total": 10})
        await on_progress(
            job,
            "complete",
            {"download_url": f"/jobs/{job.id}/download", "chapters": 0},
        )

    app = server_mod.create_app()
    jm = JobManager(pipeline=fake_pipeline)
    jm.start()
    app.state.job_manager = jm
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=5.0) as c:
        try:
            # Submit a job by hand (skip /upload since we don't need a real PDF for SSE).
            tmp = tmp_walnut_dir / "fake.pdf"
            tmp.write_bytes(b"%PDF-1.4\n")
            job = jm.submit(str(tmp), "fake.pdf", 1)

            # Stream SSE.
            async with c.stream("GET", f"/jobs/{job.id}/events") as resp:
                assert resp.status_code == 200
                # SSE lines are framed by `\n\n`; collect events as raw text lines.
                buf = ""
                async for chunk in resp.aiter_text():
                    buf += chunk
                    if "event: complete" in buf or "event: error" in buf:
                        # Give the server a moment to close.
                        break
                # We expect inspect, extract, complete events.
                assert "stage" in buf
                assert "inspect" in buf
                assert "complete" in buf
        finally:
            await jm.stop()


@pytest.mark.asyncio
async def test_confirm_404_for_unknown_job(client: httpx.AsyncClient) -> None:
    resp = await client.post("/jobs/nope/confirm", json={"chapters": []})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_download_404_for_unknown_job(client: httpx.AsyncClient) -> None:
    resp = await client.get("/jobs/nope/download")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_204_when_known(client: httpx.AsyncClient, fixture_pdf: Path) -> None:
    with fixture_pdf.open("rb") as f:
        files = {"file": ("foo.pdf", f, "application/pdf")}
        resp = await client.post("/upload", files=files)
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    resp2 = await client.delete(f"/jobs/{job_id}")
    assert resp2.status_code == 204
