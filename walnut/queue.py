from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from walnut.errors import CANCELLED, INTERNAL, WalnutError

logger = logging.getLogger(__name__)


JobStatus = str  # one of: queued, running, awaiting_confirmation, writing, complete, error, cancelled


def _new_job_id() -> str:
    return f"j_{secrets.token_hex(8)}"


@dataclass
class Job:
    id: str
    src_path: str
    out_path: str
    orig_name: str
    page_count: int
    status: JobStatus = "queued"
    error: str | None = None
    chapters: list[Any] = field(default_factory=list)
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    awaiting_confirmation: asyncio.Event = field(default_factory=asyncio.Event)
    confirmed_chapters: list[Any] | None = None
    subscribers: list[asyncio.Queue[dict[str, Any]]] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)
    closed: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


# Sentinel used to close subscriber queues when the job ends.
_CLOSE_SENTINEL: dict[str, Any] = {"__close__": True}


PipelineFn = Callable[[Job, Callable[[Job, str, dict[str, Any]], Awaitable[None]]], Awaitable[None]]


class JobManager:
    """In-memory FIFO job queue. One async worker, fan-out subscribers per job."""

    def __init__(self, pipeline: PipelineFn | None = None) -> None:
        self._jobs: dict[str, Job] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker_task: asyncio.Task[None] | None = None
        self._pipeline: PipelineFn | None = pipeline

    @property
    def jobs(self) -> dict[str, Job]:
        return self._jobs

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def submit(self, src_path: str, orig_name: str, page_count: int) -> Job:
        job_id = _new_job_id()
        # Build out_path: e.g. /tmp/walnut/<job_id>/walnut-<orig_name>
        # The pipeline writes into the temp dir; the server resolves the right name on download.
        from pathlib import Path

        tmp = Path(src_path).parent
        # Strip any leading walnut- to avoid doubling.
        stripped = orig_name
        while stripped.startswith("walnut-"):
            stripped = stripped[len("walnut-") :]
        out_name = f"walnut-{stripped}"
        out_path = str(tmp / out_name)
        job = Job(
            id=job_id,
            src_path=src_path,
            out_path=out_path,
            orig_name=stripped,
            page_count=page_count,
        )
        self._jobs[job_id] = job
        self._queue.put_nowait(job_id)
        return job

    def subscribe(self, job_id: str) -> asyncio.Queue[dict[str, Any]]:
        job = self._jobs[job_id]
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        for prior in job.history:
            q.put_nowait(prior)
        if job.closed:
            q.put_nowait(_CLOSE_SENTINEL)
        else:
            job.subscribers.append(q)
        return q

    def confirm(self, job_id: str, chapters: list[Any]) -> None:
        job = self._jobs[job_id]
        job.confirmed_chapters = chapters
        job.awaiting_confirmation.set()

    def cancel(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job is None:
            return
        job.cancel.set()
        # Also unblock confirm waits.
        job.awaiting_confirmation.set()

    def start(self) -> None:
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except (asyncio.CancelledError, BaseException):
                pass
            self._worker_task = None

    async def _emit(self, job: Job, event: str, data: dict[str, Any]) -> None:
        message = {"event": event, "data": data}
        job.history.append(message)
        for q in list(job.subscribers):
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                logger.warning("dropping event for slow subscriber on job %s", job.id)

    async def _close_subscribers(self, job: Job) -> None:
        job.closed = True
        for q in list(job.subscribers):
            try:
                q.put_nowait(_CLOSE_SENTINEL)
            except asyncio.QueueFull:
                pass

    async def _run_forever(self) -> None:
        from walnut.pipeline import process_pdf  # local import to avoid cycle

        runner = self._pipeline or process_pdf
        while True:
            try:
                job_id = await self._queue.get()
            except asyncio.CancelledError:
                return
            job = self._jobs.get(job_id)
            if job is None:
                continue
            if job.cancel.is_set():
                job.status = "cancelled"
                await self._close_subscribers(job)
                continue
            job.status = "running"
            try:
                await runner(job, self._emit)
                if job.cancel.is_set() and job.status not in ("complete", "error"):
                    job.status = "cancelled"
                elif job.status not in ("complete", "error", "cancelled"):
                    job.status = "complete"
            except WalnutError as e:
                if e.code == CANCELLED:
                    job.status = "cancelled"
                else:
                    job.status = "error"
                    job.error = e.message
                    await self._emit(job, "error", {"code": e.code, "message": e.message})
            except asyncio.CancelledError:
                job.status = "cancelled"
                await self._emit(job, "error", {"code": CANCELLED, "message": "cancelled"})
                raise
            except Exception as e:  # noqa: BLE001
                logger.exception("pipeline crashed for job %s", job_id)
                job.status = "error"
                job.error = str(e)
                await self._emit(job, "error", {"code": INTERNAL, "message": str(e)})
            finally:
                await self._close_subscribers(job)
