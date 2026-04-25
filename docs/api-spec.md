# API Specification

All routes mounted at `/`. Bound to `127.0.0.1`. CORS allowlist: `http://localhost:*`, `http://127.0.0.1:*`.

## Endpoints

### `POST /upload`

Stream-upload a PDF. Server stores it under `/tmp/walnut/<job_id>/in.pdf` in 1 MiB chunks.

**Request**
```
POST /upload
Content-Type: multipart/form-data; boundary=...

file: <PDF binary>
```

**Response: 202 Accepted**
```json
{
  "job_id": "j_01HXYZ7K3M2",
  "filename": "the-trial.pdf",
  "size_bytes": 4823104,
  "page_count": 312,
  "encrypted": false,
  "has_existing_toc": false
}
```

**Errors**
- `400 only_pdf` — file extension is not `.pdf` or magic bytes don't start with `%PDF-`.
- `413 too_large` — > 200 MB (configurable via `WALNUT_MAX_BYTES`).
- `422 encrypted` — `inspect_pdf` reports `encrypted=true and needs_password=true`.
- `422 has_existing_toc` — PDF already has bookmarks AND `replace_existing` query param is not set.

### `GET /jobs/:id/events` (Server-Sent Events)

Subscribe to job progress. The connection stays open until `event: complete` or `event: error` is emitted.

**Response: 200**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: stage
data: {"stage":"inspect"}

event: stage
data: {"stage":"extract","page":1,"total":312}

event: stage
data: {"stage":"extract","page":312,"total":312}

event: stage
data: {"stage":"toc","found":true}

event: stage
data: {"stage":"llm","tokens_in":3412}

event: stage
data: {"stage":"score"}

event: preview
data: {
  "chapters":[
    {"id":"c1","title":"Chapter 1","page":3,"level":1,"confidence":0.94},
    {"id":"c2","title":"Chapter 2","page":21,"level":1,"confidence":0.61,"flag":"low_conf"},
    ...
  ]
}

event: stage
data: {"stage":"write"}

event: complete
data: {"download_url":"/jobs/j_01HXYZ7K3M2/download","chapters":14}
```

**Errors**
```
event: error
data: {"code":"OLLAMA_DOWN","message":"Cannot reach localhost:11434."}
```

Error codes:

| Code | Meaning | UX message |
|---|---|---|
| `ENCRYPTED` | Password-protected PDF | "the file is password-protected. walnut does not unlock encrypted pdfs." |
| `NO_TEXT` | Scanned/image-only PDF | "this looks like a scanned PDF (no text layer). run `ocrmypdf` first." |
| `OLLAMA_DOWN` | Cannot reach `:11434` | "I can't reach Ollama. is it running?" |
| `MODEL_MISSING` | Model not pulled | "Ollama is up, but `gemma4:e4b` isn't pulled." |
| `NO_CHAPTERS` | Pipeline produced 0 chapters | "the model didn't find any chapters." (offer save-anyway / retry-larger) |
| `INVALID_PDF` | File corrupted past repair | "this file is corrupted past repair." |
| `TOO_LARGE` | > 200 MB | "this file is over 200 MB. try splitting it first." |
| `CANCELLED` | User cancelled | (no UX message; just go back to idle) |
| `INTERNAL` | Anything unexpected | "something went wrong. check the terminal log." |

### `POST /jobs/:id/confirm`

Submit the user's edited chapter list to trigger the write.

**Request**
```json
{
  "chapters": [
    {"title":"The Arrest","page":3,"level":1},
    {"title":"Conversation with Frau Grubach","page":21,"level":1}
  ]
}
```

**Response: 202** — server begins the write stage and emits SSE updates.

**Errors**
- `400 invalid_chapters` — schema validation failed.
- `404 not_found` — unknown job id.
- `409 wrong_state` — job is not in `awaiting_confirmation` state.

### `GET /jobs/:id/download`

Download the finished PDF.

**Response: 200**
```
Content-Type: application/pdf
Content-Disposition: attachment; filename="walnut-the-trial.pdf"

<bytes>
```

**Errors**
- `404 not_found` — unknown job id.
- `409 not_complete` — job hasn't finished.

### `DELETE /jobs/:id`

Cancel an in-flight job and clean up its temp files.

**Response: 204 No Content**

If the worker is mid-stage when this is called, the job's `cancel` event is set; the worker checks between stages and aborts cleanly.

### `GET /healthz`

Doctor endpoint for the UI footer and CLI doctor command.

**Response: 200**
```json
{
  "ok": true,
  "ollama": {"reachable": true, "version": "0.5.4"},
  "model":  {"name": "gemma4:e4b", "loaded": true, "size_bytes": 9617825792},
  "disk":   {"tmp_free_bytes": 121483623424}
}
```

If Ollama is unreachable: `ok: false`, status 503.

### `GET /jobs` (debug)

Lists in-memory jobs. Used by the cancel-all dev tool. Not exposed in the UI.

## SSE event taxonomy

| Event | Payload | Notes |
|---|---|---|
| `stage` | `{stage: "inspect" \| "extract" \| "toc" \| "llm" \| "score" \| "write", ...stage-specific}` | Progress only; never terminal. |
| `preview` | `{chapters: [...]}` | Pauses pipeline; awaits `confirm`. |
| `complete` | `{download_url, chapters}` | Terminal. Connection closes. |
| `error` | `{code, message}` | Terminal. Connection closes. |

## Job lifecycle

```
   submit
     |
     v
  [queued] --(worker picks)--> [running]
                                  |
                                  +---> [awaiting_confirmation]
                                  |          |
                                  |          +-- confirm --> [writing] --> [complete]
                                  |          +-- cancel  --> [cancelled]
                                  |
                                  +-- error --> [error]
                                  +-- cancel --> [cancelled]
```

A job in `awaiting_confirmation` blocks the worker. The next queued job does not start until the user confirms (or cancels). This is intentional: only one LLM at a time, only one user.

Timeout: a job sitting in `awaiting_confirmation` for > 30 min auto-cancels.

## Quotas / limits

- Max upload: **200 MB** (`WALNUT_MAX_BYTES`).
- Max page count: **2000** (anything bigger almost certainly belongs in batch mode).
- Per-job temp dir lives in `/tmp/walnut/<job_id>/`; cleaned 1 h after `complete` or immediately on `cancel`.
- Concurrent upload connections: 4 (FastAPI default; bounded by uvicorn workers — we run 1).

## Security notes

- We bind to `127.0.0.1` only. There is no auth.
- An attacker on the same machine could in principle hit the API. Out of scope for v1; if the user lets others on the box, that's a different threat model.
- We do not log the file contents or LLM responses to disk by default. Stage events are logged at INFO level (no PDF bytes).
- The output filename includes the user's original filename. Sanitize: strip path separators, NUL bytes, control characters; cap length at 200 chars to keep `Content-Disposition` sane.
