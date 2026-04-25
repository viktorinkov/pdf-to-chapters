from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import pytest

from walnut.queue import Job, JobManager


async def _noop_pipeline(job: Job, on_progress: Callable[[Job, str, dict[str, Any]], Awaitable[None]]) -> None:
    await on_progress(job, "stage", {"stage": "inspect"})
    await on_progress(job, "complete", {"download_url": f"/jobs/{job.id}/download", "chapters": 0})


def test_submit_returns_job_with_id(tmp_path: Any) -> None:
    src = tmp_path / "in.pdf"
    src.write_bytes(b"%PDF-1.4\n")
    jm = JobManager(pipeline=_noop_pipeline)
    job = jm.submit(src_path=str(src), orig_name="hello.pdf", page_count=10)
    assert job.id.startswith("j_")
    assert job.src_path == str(src)
    assert job.page_count == 10
    assert job.status == "queued"
    assert job.orig_name == "hello.pdf"
    assert job.out_path.endswith("walnut-hello.pdf")


def test_submit_strips_existing_walnut_prefix(tmp_path: Any) -> None:
    src = tmp_path / "in.pdf"
    src.write_bytes(b"%PDF-1.4\n")
    jm = JobManager(pipeline=_noop_pipeline)
    job = jm.submit(src_path=str(src), orig_name="walnut-foo.pdf", page_count=1)
    # Output is single-prefixed.
    assert job.out_path.endswith("walnut-foo.pdf")
    assert "walnut-walnut-" not in job.out_path


@pytest.mark.asyncio
async def test_subscribe_yields_emitted_events(tmp_path: Any) -> None:
    src = tmp_path / "in.pdf"
    src.write_bytes(b"%PDF-1.4\n")
    jm = JobManager(pipeline=_noop_pipeline)
    jm.start()
    try:
        job = jm.submit(str(src), "f.pdf", 1)
        q = jm.subscribe(job.id)
        events: list[dict[str, Any]] = []
        # Drain until the close sentinel arrives.
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=2.0)
            except asyncio.TimeoutError:
                pytest.fail("subscriber timed out before close")
            if msg.get("__close__"):
                break
            events.append(msg)
        kinds = [e["event"] for e in events]
        assert "stage" in kinds
        assert "complete" in kinds
    finally:
        await jm.stop()


def test_cancel_sets_event(tmp_path: Any) -> None:
    src = tmp_path / "in.pdf"
    src.write_bytes(b"%PDF-1.4\n")
    jm = JobManager(pipeline=_noop_pipeline)
    job = jm.submit(str(src), "f.pdf", 1)
    assert not job.cancel.is_set()
    jm.cancel(job.id)
    assert job.cancel.is_set()


def test_confirm_sets_chapters_and_event(tmp_path: Any) -> None:
    src = tmp_path / "in.pdf"
    src.write_bytes(b"%PDF-1.4\n")
    jm = JobManager(pipeline=_noop_pipeline)
    job = jm.submit(str(src), "f.pdf", 1)
    payload = [{"title": "X", "page": 1, "level": 1}]
    assert not job.awaiting_confirmation.is_set()
    assert job.confirmed_chapters is None
    jm.confirm(job.id, payload)
    assert job.awaiting_confirmation.is_set()
    assert job.confirmed_chapters == payload
