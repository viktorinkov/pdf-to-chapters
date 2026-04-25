/* walnut — Alpine.js component
 * State machine and SSE handling for the upload + preview + write flow.
 * Talks to the FastAPI backend defined in docs/api-spec.md.
 */

const errorMessages = {
  ENCRYPTED:
    "this file is password-protected. walnut does not unlock encrypted pdfs.",
  TOO_LARGE:
    "this file is over 200 MB. try splitting it first.",
  OLLAMA_DOWN:
    "I can't reach Ollama on localhost:11434. is it running? try `brew services start ollama`.",
  MODEL_MISSING:
    "Ollama is up, but `gemma4:e4b` isn't pulled. run `ollama pull gemma4:e4b`.",
  NO_TEXT:
    "this looks like a scanned PDF (no text layer). run `ocrmypdf input.pdf input_ocr.pdf` first.",
  NO_CHAPTERS:
    "the model didn't find any chapters in this PDF.",
  INVALID_PDF:
    "this file is corrupted past repair. sorry.",
  CANCELLED:
    "cancelled.",
  INTERNAL:
    "something went wrong. check the terminal log for details.",
};

function pctForStage(stage, page, total) {
  switch (stage) {
    case "inspect": return 3;
    case "extract":
      if (typeof page === "number" && typeof total === "number" && total > 0) {
        return 5 + Math.min(55, Math.round((page / total) * 55));
      }
      return 30;
    case "toc":   return 63;
    case "llm":   return 78;
    case "score": return 92;
    case "write": return 97;
    default:      return undefined;
  }
}

function statusForStage(stage, data) {
  switch (stage) {
    case "inspect": return "inspecting pdf...";
    case "extract":
      if (data && data.page && data.total) {
        return `reading text . page ${data.page} / ${data.total}`;
      }
      return "extracting text...";
    case "toc":
      return data && data.found ? "table of contents found" : "no printed toc, falling back to llm";
    case "llm":
      if (data && data.tokens_in) return `asking gemma . ${data.tokens_in} tokens in`;
      return "asking gemma to find chapters...";
    case "score": return "scoring confidence...";
    case "write": return "writing bookmarks...";
    default: return "...";
  }
}

function walnut() {
  return {
    // ---- state ----
    screen: "idle",
    hover: false,
    dragCounter: 0,
    job: { id: null, filename: "", size_bytes: 0, page_count: 0 },
    pct: 0,
    status: "",
    chapters: [],
    errMsg: "",
    errCode: "",
    logLines: [],
    healthStatus: { state: "checking", text: "checking ollama..." },
    aboutOpen: false,
    eventSource: null,
    confirming: false,
    errorMessages,

    // ---- lifecycle ----
    async init() {
      try {
        const res = await fetch("/healthz");
        if (res.ok) {
          const j = await res.json();
          if (j && j.ok && j.ollama && j.ollama.reachable) {
            const model = j.model && j.model.name ? j.model.name : "gemma4:e4b";
            this.healthStatus = {
              state: "ok",
              text: `ollama: ready . model ${model}`,
            };
          } else if (j && j.model && j.ollama && j.ollama.reachable && !j.model.loaded) {
            this.healthStatus = { state: "warn", text: "ollama: ready . model not pulled" };
          } else {
            this.healthStatus = { state: "warn", text: "ollama: degraded" };
          }
        } else {
          this.healthStatus = { state: "err", text: "ollama: not running" };
        }
      } catch (e) {
        this.healthStatus = { state: "err", text: "ollama: unreachable" };
      }

      // close modal on Escape
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.aboutOpen) this.aboutOpen = false;
      });
    },

    // ---- drag-and-drop ----
    onDragEnter() {
      this.dragCounter++;
      this.hover = true;
    },
    onDragLeave() {
      this.dragCounter = Math.max(0, this.dragCounter - 1);
      if (this.dragCounter === 0) this.hover = false;
    },
    onDrop(e) {
      this.hover = false;
      this.dragCounter = 0;
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      this.upload(file);
    },
    onPick(e) {
      const file = e.target && e.target.files && e.target.files[0];
      if (!file) return;
      this.upload(file);
    },

    // ---- upload ----
    async upload(file) {
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        return this.fail("INVALID_PDF", "Only .pdf files are supported.");
      }

      this.screen = "run";
      this.pct = 1;
      this.status = "uploading...";
      this.logLines = [];
      this.addLogLine(`uploading ${file.name} (${formatBytes(file.size)})`);

      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/upload", { method: "POST", body: fd });
        if (!res.ok) {
          let code = "INTERNAL";
          try {
            const j = await res.json();
            if (j && j.detail) code = String(j.detail).toUpperCase();
            if (j && j.code) code = j.code;
          } catch (_) {}
          if (res.status === 413) code = "TOO_LARGE";
          if (res.status === 422) code = code || "ENCRYPTED";
          return this.fail(code);
        }
        const j = await res.json();
        this.job = {
          id: j.job_id,
          filename: j.filename,
          size_bytes: j.size_bytes,
          page_count: j.page_count,
        };
        this.addLogLine(`opened pdf, ${j.page_count} pages`);
        this.status = "inspecting pdf...";
        this.pct = 3;
        this.listen();
      } catch (err) {
        this.fail("INTERNAL", String(err));
      }
    },

    // ---- SSE ----
    listen() {
      if (this.eventSource) {
        try { this.eventSource.close(); } catch (_) {}
      }
      const es = new EventSource(`/jobs/${this.job.id}/events`);
      this.eventSource = es;

      es.addEventListener("stage", (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch (_) {}
        const stage = data.stage;
        const next = pctForStage(stage, data.page, data.total);
        if (typeof next === "number") this.pct = Math.max(this.pct, next);
        this.status = statusForStage(stage, data);
        // Keep the log readable: only log stage transitions and final extract page.
        const last = this.logLines.length ? this.logLines[this.logLines.length - 1].stage : null;
        if (stage !== last) {
          this.addLogLine(this.status, stage);
        } else if (stage === "extract" && data.page === data.total) {
          this.addLogLine(`extracted all ${data.total} pages`, stage);
        }
      });

      es.addEventListener("preview", (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch (_) {}
        const list = Array.isArray(data.chapters) ? data.chapters : [];
        this.chapters = list.map((c, i) => ({
          id: c.id || `c${i + 1}`,
          title: c.title || "",
          page: typeof c.page === "number" ? c.page : 1,
          level: typeof c.level === "number" ? Math.min(3, Math.max(1, c.level)) : 1,
          confidence: typeof c.confidence === "number" ? c.confidence : null,
          flag: c.flag || (typeof c.confidence === "number" && c.confidence < 0.85 ? "low_conf" : null),
          editing: false,
        }));
        this.pct = 95;
        this.screen = "preview";
      });

      es.addEventListener("complete", (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch (_) {}
        this.pct = 100;
        this.status = "done";
        this.addLogLine(`done, ${data.chapters || this.chapters.length} chapters written`);
        this.screen = "done";
        try { es.close(); } catch (_) {}
        this.eventSource = null;
        // Auto-trigger download after 500ms
        setTimeout(() => {
          if (this.job && this.job.id) {
            const url = `/jobs/${this.job.id}/download`;
            const a = document.createElement("a");
            a.href = url;
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        }, 500);
      });

      es.addEventListener("error", (e) => {
        let data = null;
        if (e && e.data) {
          try { data = JSON.parse(e.data); } catch (_) {}
        }
        if (data && data.code) {
          this.fail(data.code, data.message);
        } else if (es.readyState === EventSource.CLOSED && this.screen === "run") {
          this.fail("INTERNAL", "Connection to server lost.");
        }
        try { es.close(); } catch (_) {}
        this.eventSource = null;
      });
    },

    // ---- preview edits ----
    editTitle(idx, value) {
      if (this.chapters[idx]) {
        this.chapters[idx].title = value;
      }
    },
    nudgePage(idx, delta) {
      const c = this.chapters[idx];
      if (!c) return;
      const max = this.job.page_count || 99999;
      c.page = Math.max(1, Math.min(max, c.page + delta));
    },
    deleteChapter(idx) {
      this.chapters.splice(idx, 1);
    },
    addChapter() {
      const last = this.chapters[this.chapters.length - 1];
      const page = last ? Math.min(this.job.page_count || 9999, last.page + 1) : 1;
      this.chapters.push({
        id: `c-new-${Date.now()}`,
        title: "Untitled chapter",
        page,
        level: 1,
        confidence: null,
        flag: null,
        editing: true,
      });
    },
    setLevel(idx, level) {
      const c = this.chapters[idx];
      if (!c) return;
      c.level = Math.min(3, Math.max(1, level));
    },

    // ---- confirm + cancel ----
    async confirm() {
      if (this.confirming) return;
      this.confirming = true;
      const payload = {
        chapters: this.chapters.map((c) => ({
          title: c.title.trim() || "Untitled",
          page: c.page,
          level: c.level,
        })),
      };
      this.screen = "run";
      this.pct = 95;
      this.status = "writing bookmarks...";
      this.addLogLine(`confirmed ${payload.chapters.length} chapters`);
      try {
        const res = await fetch(`/jobs/${this.job.id}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          let code = "INTERNAL";
          try {
            const j = await res.json();
            if (j && j.code) code = j.code;
            if (j && j.detail && typeof j.detail === "string") {
              code = j.detail.toUpperCase();
            }
          } catch (_) {}
          this.confirming = false;
          return this.fail(code);
        }
        // Re-subscribe for write/complete events if the connection closed.
        if (!this.eventSource) this.listen();
      } catch (err) {
        this.confirming = false;
        this.fail("INTERNAL", String(err));
      }
    },

    async cancel() {
      if (!this.job.id) return this.reset();
      try {
        await fetch(`/jobs/${this.job.id}`, { method: "DELETE" });
      } catch (_) { /* ignore */ }
      if (this.eventSource) {
        try { this.eventSource.close(); } catch (_) {}
        this.eventSource = null;
      }
      this.reset();
    },

    // ---- terminal states ----
    fail(code, extra) {
      this.errCode = code;
      const friendly = errorMessages[code] || errorMessages.INTERNAL;
      this.errMsg = extra ? `${friendly}\n\n${extra}` : friendly;
      this.screen = "err";
      if (this.eventSource) {
        try { this.eventSource.close(); } catch (_) {}
        this.eventSource = null;
      }
    },

    reset() {
      this.screen = "idle";
      this.hover = false;
      this.dragCounter = 0;
      this.job = { id: null, filename: "", size_bytes: 0, page_count: 0 };
      this.pct = 0;
      this.status = "";
      this.chapters = [];
      this.errMsg = "";
      this.errCode = "";
      this.logLines = [];
      this.confirming = false;
    },

    // ---- log helpers ----
    addLogLine(text, stage = null) {
      this.logLines.push({ id: Date.now() + Math.random(), text, stage });
      if (this.logLines.length > 200) {
        this.logLines.splice(0, this.logLines.length - 200);
      }
      this.$nextTick(() => {
        const el = document.querySelector(".log");
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    // ---- formatters ----
    fmtSize(bytes) { return formatBytes(bytes); },
    fmtPages(n) { return `${n} page${n === 1 ? "" : "s"}`; },
    downloadFilename() {
      const base = (this.job.filename || "output").replace(/\.pdf$/i, "");
      return `walnut-${base}.pdf`;
    },
  };
}

function formatBytes(b) {
  if (!b && b !== 0) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Expose globally so Alpine can find walnut() in inline x-data.
window.walnut = walnut;
