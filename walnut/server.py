from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from walnut.errors import ENCRYPTED, INVALID_PDF, TOO_LARGE, WalnutError
from walnut.llm import DEFAULT_MODEL, OllamaClient
from walnut.pdf import inspect_pdf
from walnut.queue import JobManager

logger = logging.getLogger(__name__)


WALNUT_MAX_BYTES = int(os.getenv("WALNUT_MAX_BYTES", "200000000"))
TMP_ROOT = Path(os.getenv("WALNUT_TMP_DIR", "/tmp/walnut"))


_FILENAME_BAD_RE = re.compile(r"[\x00-\x1f\x7f]")


def sanitize_filename(name: str) -> str:
    """Strip path separators, NUL/control chars; cap to 200 chars; ensure `.pdf` suffix."""
    if not name:
        return "input.pdf"
    # Only keep the basename to defeat traversal.
    base = os.path.basename(name)
    base = base.replace("\\", "/").split("/")[-1]
    base = _FILENAME_BAD_RE.sub("", base)
    base = base.strip()
    if not base:
        base = "input.pdf"
    # Cap length but preserve `.pdf` suffix if present.
    if len(base) > 200:
        if base.lower().endswith(".pdf"):
            stem = base[:-4]
            base = stem[: 200 - 4] + ".pdf"
        else:
            base = base[:200]
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    return base


def strip_walnut_prefix(name: str) -> str:
    while name.startswith("walnut-"):
        name = name[len("walnut-") :]
    return name


def _ensure_web_dir() -> Path:
    web_dir = Path(__file__).parent / "web"
    web_dir.mkdir(parents=True, exist_ok=True)
    index = web_dir / "index.html"
    if not index.exists():
        index.write_text(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>walnut</title>"
            "</head><body><h1>walnut</h1>"
            "<p>frontend not built yet. backend is up.</p></body></html>",
            encoding="utf-8",
        )
    return web_dir


class ConfirmRequest(BaseModel):
    chapters: list[dict[str, Any]] = Field(default_factory=list)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    jm = JobManager()
    jm.start()
    app.state.job_manager = jm
    try:
        yield
    finally:
        await jm.stop()


def create_app() -> FastAPI:
    app = FastAPI(title="walnut", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )

    @app.exception_handler(WalnutError)
    async def _walnut_handler(request: Request, exc: WalnutError) -> JSONResponse:
        status = 422 if exc.code == ENCRYPTED else 400
        return JSONResponse(
            status_code=status, content={"code": exc.code, "message": exc.message}
        )

    @app.post("/upload", status_code=202)
    async def upload(request: Request, file: UploadFile) -> dict[str, Any]:
        if file.filename is None or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail={"code": "only_pdf", "message": "must be a .pdf file"})

        sanitized = sanitize_filename(file.filename)
        # Compute output name without doubling the prefix.
        out_basename = "walnut-" + strip_walnut_prefix(sanitized)

        jm: JobManager = app.state.job_manager
        # Reserve a job-id-shaped temp dir before we know the id (we'll move it after).
        # Simpler approach: write to a staging path, then rename when we have a job id.
        TMP_ROOT.mkdir(parents=True, exist_ok=True)
        from secrets import token_hex
        staging_dir = TMP_ROOT / f"upload_{token_hex(8)}"
        staging_dir.mkdir(parents=True, exist_ok=True)
        in_path = staging_dir / "in.pdf"

        size = 0
        first_chunk: bytes = b""
        try:
            with in_path.open("wb") as f:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    if not first_chunk:
                        first_chunk = chunk[:8]
                    size += len(chunk)
                    if size > WALNUT_MAX_BYTES:
                        f.close()
                        shutil.rmtree(staging_dir, ignore_errors=True)
                        raise HTTPException(
                            status_code=413,
                            detail={"code": TOO_LARGE, "message": f"file exceeds {WALNUT_MAX_BYTES} bytes"},
                        )
                    f.write(chunk)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail={"code": INVALID_PDF, "message": str(e)}) from e

        if not first_chunk.startswith(b"%PDF-"):
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail={"code": "only_pdf", "message": "not a PDF (bad magic)"})

        # Inspect to get page count + encryption status.
        try:
            info = inspect_pdf(str(in_path))
        except WalnutError:
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise
        except Exception as e:  # noqa: BLE001
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail={"code": INVALID_PDF, "message": str(e)}) from e

        if info.get("encrypted") and info.get("needs_password"):
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise HTTPException(
                status_code=422, detail={"code": ENCRYPTED, "message": "PDF is password-protected"}
            )

        page_count = int(info.get("pages", 0))
        encrypted = bool(info.get("encrypted"))
        has_existing_toc = bool(info.get("has_existing_toc"))

        # Submit; that gives us the job id. Then move the staging dir.
        job = jm.submit(
            src_path=str(in_path),  # will be updated below
            orig_name=sanitized,
            page_count=page_count,
        )

        # Move staging dir to /tmp/walnut/<job_id>/.
        target_dir = TMP_ROOT / job.id
        if target_dir.exists():
            shutil.rmtree(target_dir, ignore_errors=True)
        staging_dir.rename(target_dir)
        new_in = target_dir / "in.pdf"
        out_name = out_basename
        new_out = target_dir / out_name
        job.src_path = str(new_in)
        job.out_path = str(new_out)

        return {
            "job_id": job.id,
            "filename": sanitized,
            "size_bytes": size,
            "page_count": page_count,
            "encrypted": encrypted,
            "has_existing_toc": has_existing_toc,
        }

    @app.get("/jobs/{job_id}/events")
    async def jobs_events(job_id: str) -> EventSourceResponse:
        jm: JobManager = app.state.job_manager
        job = jm.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="not_found")
        q = jm.subscribe(job_id)

        async def event_gen() -> AsyncIterator[dict[str, Any]]:
            import json as _json
            try:
                while True:
                    msg = await q.get()
                    if msg.get("__close__"):
                        break
                    yield {
                        "event": msg["event"],
                        "data": _json.dumps(msg.get("data", {})),
                    }
                    if msg["event"] in ("complete", "error"):
                        break
            except asyncio.CancelledError:
                return

        return EventSourceResponse(event_gen())

    @app.post("/jobs/{job_id}/confirm", status_code=202)
    async def jobs_confirm(job_id: str, body: ConfirmRequest) -> dict[str, Any]:
        jm: JobManager = app.state.job_manager
        job = jm.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "unknown job"})
        if job.status != "awaiting_confirmation":
            raise HTTPException(
                status_code=409,
                detail={"code": "wrong_state", "message": f"job is {job.status}, not awaiting_confirmation"},
            )
        if not isinstance(body.chapters, list):
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_chapters", "message": "chapters must be a list"},
            )
        jm.confirm(job_id, body.chapters)
        return {"ok": True}

    @app.get("/jobs/{job_id}/download")
    async def jobs_download(job_id: str) -> FileResponse:
        jm: JobManager = app.state.job_manager
        job = jm.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="not_found")
        if job.status != "complete":
            raise HTTPException(status_code=409, detail={"code": "not_complete", "message": f"status={job.status}"})
        download_name = "walnut-" + job.orig_name
        return FileResponse(
            path=job.out_path,
            media_type="application/pdf",
            filename=download_name,
        )

    @app.delete("/jobs/{job_id}", status_code=204)
    async def jobs_cancel(job_id: str) -> None:
        jm: JobManager = app.state.job_manager
        if jm.get(job_id) is None:
            raise HTTPException(status_code=404, detail="not_found")
        jm.cancel(job_id)

    @app.get("/jobs")
    async def jobs_list() -> dict[str, Any]:
        jm: JobManager = app.state.job_manager
        return {
            "jobs": [
                {
                    "id": j.id,
                    "status": j.status,
                    "page_count": j.page_count,
                    "orig_name": j.orig_name,
                    "error": j.error,
                }
                for j in jm.jobs.values()
            ]
        }

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        llm_mode = os.getenv("WALNUT_LLM_MODE", "on").lower()
        tmp_free = 0
        try:
            stat = shutil.disk_usage(str(TMP_ROOT.parent if TMP_ROOT.parent.exists() else "/"))
            tmp_free = stat.free
        except Exception:  # noqa: BLE001
            tmp_free = 0

        if llm_mode == "off":
            return JSONResponse(
                status_code=200,
                content={
                    "ok": True,
                    "ollama": {"reachable": False, "mode": "off"},
                    "model": {"name": DEFAULT_MODEL, "loaded": False},
                    "disk": {"tmp_free_bytes": tmp_free},
                },
            )

        client = OllamaClient()
        try:
            reachable = False
            loaded = False
            try:
                reachable = await client.is_reachable()
            except Exception:  # noqa: BLE001
                reachable = False
            if reachable:
                try:
                    loaded = await client.has_model(DEFAULT_MODEL)
                except Exception:  # noqa: BLE001
                    loaded = False
        finally:
            await client.aclose()

        body = {
            "ok": reachable,
            "ollama": {"reachable": reachable},
            "model": {"name": DEFAULT_MODEL, "loaded": loaded},
            "disk": {"tmp_free_bytes": tmp_free},
        }
        return JSONResponse(status_code=200 if reachable else 503, content=body)

    # Mount the static frontend last so API routes win.
    web_dir = _ensure_web_dir()
    app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")

    return app


app = create_app()
