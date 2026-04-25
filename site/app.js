// walnut browser app: drop a PDF, detect chapters, save with bookmarks.
// All processing happens in the browser. No server, no upload.

const TOC_LINE_RE = /^(.+?)[\s.…]{3,}\s*([ivxlcdmIVXLCDM\d]+)\s*$/;
const TOC_HEADER_RE = /^(contents|table\s+of\s+contents|sommaire|inhalt|indice|Índice|目次|目录)\s*$/i;
const CHAPTER_PREFIX_RE = /^(chapter|part|section|book|prologue|epilogue|preface|introduction|cap[íí]tulo|kapitel|chapitre|capitolo)\b/i;

const STATE = Object.freeze({
  IDLE: "idle",
  PROCESSING: "processing",
  PREVIEW: "preview",
  DONE: "done",
  ERROR: "error",
});

const ERR = Object.freeze({
  ENCRYPTED: "this PDF is password protected. walnut can't unlock it.",
  NO_TEXT: "this PDF has no text layer. it may be a scan; try OCR first.",
  NO_CHAPTERS: "no chapters could be detected from font sizes or a printed table of contents. try the local model below, or use the desktop version.",
  TOO_LARGE_DESKTOP: "this file is over 50 MB. the browser version caps there to keep memory sane; the desktop version handles larger files.",
  TOO_LARGE_MOBILE: "this file is over 20 MB. mobile browsers run out of memory on bigger PDFs; try a desktop browser or the desktop version.",
  WRITE_FAILED: "could not write the outline. the PDF may be malformed.",
  LOAD_FAILED: "this PDF could not be opened.",
  MULTIPLE_FILES: "drop only one PDF at a time.",
  NOT_PDF: "that doesn't look like a PDF. drop a .pdf file.",
});

function isMobileUA() {
  return typeof navigator !== "undefined" && /Mobi|Android/i.test(navigator.userAgent || "");
}
const MAX_BROWSER_BYTES_DESKTOP = 50 * 1024 * 1024;
const MAX_BROWSER_BYTES_MOBILE  = 20 * 1024 * 1024;

let pdfjsLibPromise = null;
let pdfLibPromise   = null;

function loadPdfJs() {
  if (!pdfjsLibPromise) {
    if (typeof document === "undefined") {
      // Node: import pdfjs-dist from npm. Use the legacy build to avoid worker.
      pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
    } else {
      pdfjsLibPromise = import("./lib/pdf.mjs").then(mod => {
        mod.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.mjs", import.meta.url).href;
        return mod;
      });
    }
  }
  return pdfjsLibPromise;
}

function loadPdfLib() {
  if (!pdfLibPromise) {
    if (typeof document === "undefined") {
      // Node: import pdf-lib from npm.
      pdfLibPromise = import("pdf-lib");
    } else if (typeof window !== "undefined" && window.PDFLib) {
      pdfLibPromise = Promise.resolve(window.PDFLib);
    } else {
      pdfLibPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./lib/pdf-lib.min.js";
        script.onload = () => resolve(window.PDFLib);
        script.onerror = () => reject(new Error("pdf-lib failed to load"));
        document.head.appendChild(script);
      });
    }
  }
  return pdfLibPromise;
}

// ---- text extraction ---------------------------------------------------

async function extractPages(arrayBuffer, onProgress, opts) {
  const pdfjs = await loadPdfJs();
  // Slice the buffer so pdf.js can transfer ownership safely.
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer.slice(0) });
  // Caller may want to cancel (e.g. user hit cancel during processing). We
  // expose the loadingTask so handle() can call destroy() and abort the load.
  if (opts && typeof opts.onLoadingTask === "function") {
    try { opts.onLoadingTask(loadingTask); } catch (_) {}
  }
  const doc = await loadingTask.promise;
  const total = doc.numPages;
  const pages = [];
  try {
    for (let i = 1; i <= total; i++) {
      if (opts && typeof opts.shouldCancel === "function" && opts.shouldCancel()) {
        const err = new Error("cancelled");
        err.code = "CANCELLED";
        throw err;
      }
      const page = await doc.getPage(i);
      let content;
      try {
        content = await page.getTextContent();
      } catch (_) {
        content = { items: [] };
      }
      const lines = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const text = it.str;
        // Skip empty or whitespace-only items.
        if (!text || !text.trim()) continue;
        const t = it.transform || [1, 0, 0, 1, 0, 0];
        // Skip rotated text (chapter headings are never rotated in books).
        const angle = Math.atan2(t[1] || 0, t[0] || 0);
        if (Math.abs(angle) > 0.01) continue;
        // rotation-safe font size from the y-shear/scale components
        const font_size = Math.hypot(t[2] || 0, t[3] || 0);
        if (!Number.isFinite(font_size) || font_size <= 0) continue;
        lines.push({
          text,
          font_size,
          x: t[4] || 0,
          y: t[5] || 0,
          width: it.width || 0,
        });
      }
      const grouped = groupByLine(lines);
      const text = grouped.map(l => l.text).join("\n");
      pages.push({
        page_idx: i - 1,
        page_label: String(i),
        text,
        lines: grouped,
      });
      // memory hygiene: free per-page resources before moving on
      try { page.cleanup(); } catch (_) {}
      if (onProgress && (i % 5 === 0 || i === total)) onProgress(i, total);
    }
  } finally {
    // memory hygiene: release worker-side caches and the document
    try { await doc.cleanup(); } catch (_) {}
    try { await doc.destroy(); } catch (_) {}
  }
  return { pages, page_height_hint: 800 };
}

function groupByLine(items) {
  // Bucket items by ~2pt y-tolerance: round to nearest even number to absorb
  // small baseline jitter without merging two visually distinct lines.
  const buckets = new Map();
  for (const it of items) {
    const key = Math.round(it.y / 2) * 2;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  const lines = [];
  for (const [y, group] of buckets) {
    group.sort((a, b) => a.x - b.x);
    const text = group.map(g => g.text).join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const font_size = Math.max(...group.map(g => g.font_size));
    lines.push({ text, font_size, y, x: group[0].x });
  }
  // y is bottom-up in PDF coordinates: highest y == top of page.
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

// ---- TOC detection ----------------------------------------------------

function findTOCPages(pages, windowSize = 30) {
  const out = [];
  for (const p of pages.slice(0, windowSize)) {
    const lines = p.text.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 4) continue;
    const matches = lines.map(l => l.match(TOC_LINE_RE)).filter(Boolean);
    const headerHit = lines.slice(0, 3).some(l => TOC_HEADER_RE.test(l));
    const ratio = matches.length / lines.length;
    if (ratio >= 0.45 || (ratio >= 0.25 && headerHit)) {
      out.push({
        page_idx: p.page_idx,
        entries: matches.map(m => ({ title: m[1].trim(), label: m[2] })),
      });
    }
  }
  return out;
}

function parseTOC(tocPages, pages) {
  const entries = [];
  for (const tp of tocPages) {
    for (const e of tp.entries) entries.push(e);
  }
  if (entries.length === 0) return [];

  const out = [];
  for (const e of entries) {
    const physical = resolvePageLabel(e.label, pages, entries);
    if (physical < 0) continue;
    const level = inferLevel(e.title);
    out.push({
      id: `c${out.length}`,
      title: cleanTitle(e.title),
      printed_label: e.label,
      physical_page_idx: physical,
      level,
      confidence: 0.95,
    });
  }
  return dedupeChapters(out);
}

function inferLevel(title) {
  const m = title.match(/^(\d+(?:\.\d+){0,2})/);
  if (m) {
    const dots = (m[1].match(/\./g) || []).length;
    return Math.min(3, dots + 1);
  }
  return 1;
}

function cleanTitle(title) {
  return title.replace(/[\s.…]{3,}.*$/, "").trim();
}

function dedupeChapters(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.title === it.title && Math.abs(last.physical_page_idx - it.physical_page_idx) <= 1) continue;
    out.push(it);
  }
  return out;
}

function resolvePageLabel(label, pages) {
  const arabic = parseInt(label, 10);
  if (Number.isFinite(arabic)) {
    if (arabic >= 1 && arabic <= pages.length) return arabic - 1;
    return Math.min(Math.max(0, arabic - 1), pages.length - 1);
  }
  const roman = romanToInt(label);
  if (roman > 0) return Math.min(roman - 1, pages.length - 1);
  return -1;
}

function romanToInt(s) {
  if (!/^[ivxlcdmIVXLCDM]+$/.test(s)) return 0;
  const m = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const arr = s.toLowerCase().split("").map(c => m[c]);
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < (arr[i + 1] || 0)) total -= arr[i];
    else total += arr[i];
  }
  return total;
}

// ---- heuristic fallback (no TOC) -------------------------------------

function findHeadings(pages) {
  const allSizes = [];
  for (const p of pages) for (const l of p.lines) allSizes.push(l.font_size);
  if (allSizes.length === 0) return [];
  allSizes.sort((a, b) => a - b);
  const p90 = allSizes[Math.floor(allSizes.length * 0.9)] || 0;
  const median = allSizes[Math.floor(allSizes.length * 0.5)] || 0;
  const threshold = Math.max(p90, median * 1.3);

  const out = [];
  for (const p of pages) {
    if (p.lines.length === 0) continue;
    const top = p.lines.slice(0, Math.min(3, p.lines.length));
    const candidate = top.find(l =>
      l.font_size >= threshold &&
      l.text.length >= 2 &&
      l.text.length <= 100
    );
    if (!candidate) continue;
    const looksLikeChapter = candidate.font_size >= median * 1.5 || CHAPTER_PREFIX_RE.test(candidate.text);
    if (!looksLikeChapter) continue;
    out.push({
      id: `h${out.length}`,
      title: candidate.text,
      printed_label: p.page_label,
      physical_page_idx: p.page_idx,
      level: 1,
      confidence: 0.6,
    });
  }
  return dedupeChapters(out);
}

// ---- outline writing -------------------------------------------------

async function writeOutline(pdfBytes, chapters) {
  const PDFLib = await loadPdfLib();
  const { PDFDocument, PDFName, PDFArray, PDFHexString, PDFNumber, PDFDict } = PDFLib;

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  } catch (e) {
    if (PDFLib.EncryptedPDFError && e instanceof PDFLib.EncryptedPDFError) {
      const err = new Error("encrypted");
      err.code = "ENCRYPTED";
      throw err;
    }
    if (e && /encrypt|password/i.test(e.message || "")) {
      const err = new Error("encrypted");
      err.code = "ENCRYPTED";
      throw err;
    }
    throw e;
  }
  const ctx = pdfDoc.context;
  const pages = pdfDoc.getPages();
  if (pages.length === 0) throw new Error("PDF has zero pages");

  const itemRefs = chapters.map(() => ctx.nextRef());
  const outlinesRef = ctx.nextRef();

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const idx = Math.min(Math.max(0, ch.physical_page_idx | 0), pages.length - 1);
    const page = pages[idx];
    const dest = PDFArray.withContext(ctx);
    // [pageRef, /Fit] — open the page fitted to the viewer window.
    dest.push(page.ref);
    dest.push(PDFName.of("Fit"));
    const fields = new Map();
    fields.set(PDFName.of("Title"), PDFHexString.fromText(String(ch.title || "")));
    fields.set(PDFName.of("Parent"), outlinesRef);
    fields.set(PDFName.of("Dest"), dest);
    if (i > 0) fields.set(PDFName.of("Prev"), itemRefs[i - 1]);
    if (i < chapters.length - 1) fields.set(PDFName.of("Next"), itemRefs[i + 1]);
    const itemDict = PDFDict.fromMapWithContext(fields, ctx);
    ctx.assign(itemRefs[i], itemDict);
  }

  const outlinesFields = new Map();
  outlinesFields.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlinesFields.set(PDFName.of("First"), itemRefs[0]);
  outlinesFields.set(PDFName.of("Last"),  itemRefs[itemRefs.length - 1]);
  outlinesFields.set(PDFName.of("Count"), PDFNumber.of(chapters.length));
  ctx.assign(outlinesRef, PDFDict.fromMapWithContext(outlinesFields, ctx));

  pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  // Auto-open the outline panel when readers open the file.
  pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  return await pdfDoc.save({ useObjectStreams: false });
}

async function pdfHasOutline(pdfBytes) {
  try {
    const PDFLib = await loadPdfLib();
    const { PDFDocument, PDFName } = PDFLib;
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const outlines = doc.catalog.get(PDFName.of("Outlines"));
    return !!outlines;
  } catch (_) {
    return false;
  }
}

// ---- WebLLM fallback (in-browser Gemma) ------------------------------

// As of April 2026, MLC's published model registry tops out at the Gemma-2
// family for browser WebGPU builds; Gemma 4 ships in the desktop pipeline via
// Ollama but is not yet packaged as MLC weights for the web runtime. So we
// keep Gemma 2 here and surface that honestly to the user.
const LLM_MODEL_ID = "gemma-2-2b-it-q4f16_1-MLC";
const LLM_MODEL_LABEL = "Gemma 2 (browser version)";
const LLM_APPROX_MB = 1500;

const SYSTEM_PROMPT = `You are a document-structure analyzer. You extract a clean list of chapters and sections from extracted PDF text.

Rules:
1. Return ONLY entries that correspond to actual chapter/section headings in the printed book.
2. page_number is the printed page where the chapter starts. Page anchors in the input look like "### START_PAGE=42".
3. level: 1 for chapter or part, 2 for section, 3 for sub-section. Maximum depth 3.
4. Preserve the title's original capitalization, punctuation, and language. Do not translate.
5. A chapter must have a heading-style line.
6. Return entries in document order (ascending page_number). Return [] if nothing chapter-like is found.`;

const LLM_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title:       { type: "string" },
          page_number: { type: "integer", minimum: 1 },
          level:       { type: "integer", enum: [1, 2, 3] },
        },
        required: ["title", "page_number", "level"],
      },
    },
  },
  required: ["chapters"],
};

let webllmModulePromise = null;
let webllmEnginePromise = null;

function hasWebGPU() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

function loadWebLLMModule() {
  if (!webllmModulePromise) {
    webllmModulePromise = import("https://esm.run/@mlc-ai/web-llm@0.2.79");
  }
  return webllmModulePromise;
}

async function loadWebLLMEngine(onProgress) {
  if (webllmEnginePromise) return webllmEnginePromise;
  webllmEnginePromise = (async () => {
    const webllm = await loadWebLLMModule();
    const engine = await webllm.CreateMLCEngine(LLM_MODEL_ID, {
      initProgressCallback: (report) => {
        if (onProgress) onProgress(report);
      },
    });
    return engine;
  })();
  return webllmEnginePromise;
}

function annotatePagesForLLM(pages, candidateIdx) {
  const lines = [];
  for (const idx of candidateIdx) {
    const p = pages[idx];
    if (!p) continue;
    lines.push(`### START_PAGE=${p.page_label}`);
    for (const l of p.lines.slice(0, 14)) {
      lines.push(`[sz=${l.font_size.toFixed(1)}] ${l.text}`);
    }
  }
  return lines.join("\n");
}

function pickCandidatePages(pages) {
  if (pages.length === 0) return [];
  const sizes = [];
  for (const p of pages) for (const l of p.lines) sizes.push(l.font_size);
  sizes.sort((a, b) => a - b);
  const p85 = sizes[Math.floor(sizes.length * 0.85)] || 0;
  const median = sizes[Math.floor(sizes.length * 0.5)] || 0;
  const threshold = Math.max(p85, median * 1.25);
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const top = pages[i].lines.slice(0, 4);
    if (top.some(l => l.font_size >= threshold && l.text.length >= 2 && l.text.length <= 120)) {
      out.push(i);
    }
  }
  if (out.length === 0) {
    const step = Math.max(1, Math.floor(pages.length / 30));
    for (let i = 0; i < pages.length; i += step) out.push(i);
  }
  return out.slice(0, 80);
}

async function detectChaptersWithLLM(pages, onProgress) {
  const candidateIdx = pickCandidatePages(pages);
  const annotated = annotatePagesForLLM(pages, candidateIdx);

  const engine = await loadWebLLMEngine(onProgress);
  if (onProgress) onProgress({ text: "asking the model…", progress: 1 });

  const reply = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: `Extract the chapter list from the text below. Respond with valid JSON only.\n\n${annotated}` },
    ],
    response_format: { type: "json_object", schema: JSON.stringify(LLM_SCHEMA) },
    temperature: 0.2,
    max_tokens: 2048,
    stream: false,
  });

  const content = reply.choices?.[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (_) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = JSON.parse(content.slice(start, end + 1));
    else throw new Error("LLM returned invalid JSON");
  }

  const chapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  return chapters
    .filter(c => c && typeof c.title === "string" && Number.isFinite(c.page_number))
    .map((c, i) => {
      const physical = Math.min(Math.max(0, (c.page_number | 0) - 1), pages.length - 1);
      return {
        id: `l${i}`,
        title: c.title.trim().slice(0, 200),
        printed_label: String(c.page_number),
        physical_page_idx: physical,
        level: [1, 2, 3].includes(c.level) ? c.level : 1,
        confidence: 0.78,
      };
    })
    .filter(c => c.title.length > 0);
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
}

// ---- app -------------------------------------------------------------

class App {
  constructor(root) {
    this.root = root;
    this.state = STATE.IDLE;
    this.fileName = null;
    this.pdfBytes = null;
    this.chapters = [];
    this.lastError = null;
    this.detectionMode = null; // "toc" | "headings" | "llm"
    this.alreadyBookmarked = false;
    this.bookmarkWarningShown = false;
    this.bind();
    this.setState(STATE.IDLE);
  }

  bind() {
    const dz = this.q("dropzone");
    const fp = this.q("filepicker");
    if (dz && fp) {
      dz.addEventListener("dragover",  e => { e.preventDefault(); dz.classList.add("hover"); });
      dz.addEventListener("dragleave", e => { e.preventDefault(); dz.classList.remove("hover"); });
      dz.addEventListener("drop",      e => {
        e.preventDefault(); dz.classList.remove("hover");
        const files = (e.dataTransfer && e.dataTransfer.files) || [];
        if (files.length > 1) return this.fail("MULTIPLE_FILES");
        const f = files[0];
        if (f) this.handle(f);
      });
      dz.addEventListener("click", () => fp.click());
      dz.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fp.click(); }
      });
      fp.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        if (f) this.handle(f);
      });

      // Stop the browser from navigating away when a PDF is dropped on any
      // part of the page that isn't the dropzone (default behaviour is to
      // open the file in-place and lose the user's session).
      const doc = this.root && this.root.ownerDocument;
      if (doc && !doc.__walnutDragGuard) {
        const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
        const guard = (e) => {
          if (e.target && (e.target === dz || (typeof dz.contains === "function" && dz.contains(e.target)))) return;
          e.preventDefault();
          if (e.type === "drop" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
        };
        const tgt = win || doc;
        tgt.addEventListener("dragover", guard, false);
        tgt.addEventListener("drop", guard, false);
        doc.__walnutDragGuard = true;
      }
    }

    const wire = (id, ev, fn) => {
      const el = this.q(id);
      if (el) el.addEventListener(ev, fn);
    };
    wire("save-btn",   "click", () => this.confirm());
    wire("retry-btn",  "click", () => this.reset());
    wire("again-btn",  "click", () => this.reset());
    wire("err-btn",    "click", () => this.reset());
    wire("cancel-btn", "click", () => this.cancel());

    for (const btn of this.qAll("ai-preview-btn")) btn.addEventListener("click", () => this.runAI());
    for (const btn of this.qAll("ai-err-btn"))     btn.addEventListener("click", () => this.runAI());

    if (!hasWebGPU()) {
      for (const btn of this.qAll("ai-preview-btn")) {
        btn.classList.add("disabled");
        btn.setAttribute("disabled", "true");
      }
      for (const btn of this.qAll("ai-err-btn")) {
        btn.classList.add("disabled");
        btn.setAttribute("disabled", "true");
      }
      for (const note of this.qAll("ai-unsupported")) note.classList.add("on");
    }

    // Update the topbar WebGPU status pill if present.
    const pill = this.root && this.root.ownerDocument
      ? this.root.ownerDocument.querySelector('[data-walnut="webgpu-pill"]')
      : null;
    if (pill) {
      if (hasWebGPU()) {
        pill.classList.add("ok");
        pill.textContent = "WebGPU: ready";
      } else {
        pill.classList.add("bad");
        pill.textContent = "WebGPU: not available";
      }
    }
  }

  q(id) { return this.root.querySelector(`[data-walnut="${id}"]`); }
  qAll(id) { return this.root.querySelectorAll(`[data-walnut="${id}"]`); }

  setState(s, ctx) {
    this.state = s;
    this.render(ctx || {});
  }

  render(ctx) {
    for (const el of this.qAll("screen")) {
      const wanted = el.getAttribute("data-screen");
      el.classList.toggle("on", wanted === this.state);
    }
    if (this.state === STATE.PROCESSING) {
      const pct = ctx.pct ?? 0;
      const bar = this.q("bar-fill");
      if (bar) bar.style.width = pct + "%";
      const status = this.q("status");
      if (status) status.textContent = ctx.status || "";
      if (ctx.filename) {
        const name = this.q("run-name");
        if (name) name.textContent = ctx.filename;
      }
    }
    if (this.state === STATE.PREVIEW) {
      const pName = this.q("preview-name");
      if (pName) pName.textContent = this.fileName;
      const labels = {
        toc: "detected from a printed Table of Contents",
        headings: "detected from page headings",
        llm: `detected by the local model (${LLM_MODEL_LABEL})`,
      };
      const src = this.q("preview-source");
      if (src) src.textContent = labels[this.detectionMode] || "detected";
      this.renderChapters();

      // Show a one-time warning if the PDF already had bookmarks.
      const warn = this.q("bookmark-warning");
      if (warn) {
        warn.classList.toggle("on", !!this.alreadyBookmarked);
        this.bookmarkWarningShown = true;
      }
    }
    if (this.state === STATE.DONE) {
      const dn = this.q("done-name");
      if (dn) dn.textContent = this.outputName();
      const dc = this.q("done-count");
      if (dc) dc.textContent = String(this.chapters.length);
    }
    if (this.state === STATE.ERROR) {
      const t = this.q("err-text");
      if (t) t.textContent = ERR[ctx.code] || ctx.message || "something went wrong.";
      // Only offer the AI escape hatch when a PDF is loaded and WebGPU is up.
      const aiErr = this.q("ai-err-btn");
      if (aiErr) {
        const enable = !!this.cachedPages && this.cachedPages.length > 0 && hasWebGPU();
        aiErr.style.display = enable ? "" : "none";
      }
    }
  }

  outputName() {
    let base = this.fileName || "input.pdf";
    // Strip any existing walnut- prefixes (avoid walnut-walnut-foo.pdf).
    while (base.toLowerCase().startsWith("walnut-")) base = base.slice(7);
    // Sanitize: strip path separators, NULs, control chars; cap length.
    base = base.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200);
    if (!/\.pdf$/i.test(base)) base += ".pdf";
    return "walnut-" + base;
  }

  renderChapters() {
    const list = this.q("chapter-list");
    if (!list) return;
    list.innerHTML = "";
    this.chapters.forEach((ch, i) => {
      const row = document.createElement("li");
      row.className = "chapter-row level-" + ch.level + (ch.confidence < 0.85 ? " low-conf" : "");
      row.style.setProperty("--i", i);

      const title = document.createElement("input");
      title.type = "text"; title.value = ch.title; title.className = "chapter-title";
      title.setAttribute("aria-label", "chapter title");
      title.addEventListener("input", e => { this.chapters[i].title = e.target.value; });

      const page = document.createElement("div");
      page.className = "chapter-page mono";
      const minus = btn("-", () => this.nudge(i, -1), "previous page");
      const num   = document.createElement("span");
      num.className = "page-num"; num.textContent = String(ch.physical_page_idx + 1);
      const plus  = btn("+", () => this.nudge(i, +1), "next page");
      page.append(minus, num, plus);

      const del = btn("x", () => this.remove(i), "remove chapter");
      del.classList.add("del");
      del.title = "remove";

      row.append(title, page, del);
      list.appendChild(row);
    });
    function btn(label, onClick, aria) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.className = "row-btn";
      if (aria) b.setAttribute("aria-label", aria);
      b.addEventListener("click", onClick);
      return b;
    }
  }

  nudge(i, delta) {
    const ch = this.chapters[i];
    const max = (this.numPages || 1) - 1;
    ch.physical_page_idx = Math.min(Math.max(0, ch.physical_page_idx + delta), max);
    this.renderChapters();
  }
  remove(i) {
    this.chapters.splice(i, 1);
    this.renderChapters();
  }

  reset() {
    // If the user is mid-extraction, mirror cancel() side effects so we don't
    // leak a worker or keep a stale loadingTask alive.
    if (this.state === STATE.PROCESSING) this._abortInflight();
    this.fileName = null; this.pdfBytes = null; this.chapters = []; this.lastError = null;
    this.detectionMode = null;
    this.cachedPages = null;
    this.alreadyBookmarked = false;
    this.bookmarkWarningShown = false;
    this._cancelled = false;
    const fp = this.q("filepicker");
    if (fp) fp.value = "";
    this.setState(STATE.IDLE);
  }

  cancel() {
    if (this.state !== STATE.PROCESSING) return;
    this._abortInflight();
    this.reset();
  }

  _abortInflight() {
    this._cancelled = true;
    const lt = this._loadingTask;
    this._loadingTask = null;
    if (lt) {
      try { lt.destroy && lt.destroy(); } catch (_) {}
    }
  }

  async runAI() {
    if (!hasWebGPU()) {
      return this.fail("LOAD_FAILED", "your browser doesn't support WebGPU. try Chrome or Edge on a desktop.");
    }
    if (!this.cachedPages || this.cachedPages.length === 0) {
      return this.fail("LOAD_FAILED", "drop a PDF first.");
    }
    this.setState(STATE.PROCESSING, {
      pct: 4,
      status: `loading the local model (${LLM_MODEL_LABEL}, ~${LLM_APPROX_MB} MB on first run)…`,
      filename: this.fileName,
    });
    try {
      const chapters = await detectChaptersWithLLM(this.cachedPages, (report) => {
        const text = (report && report.text) || "loading model…";
        const prog = (report && typeof report.progress === "number") ? Math.max(0, Math.min(1, report.progress)) : null;
        const pct = prog === null ? 35 : Math.round(prog * 80) + 5;
        this.setState(STATE.PROCESSING, { pct, status: text, filename: this.fileName });
      });
      if (!chapters.length) return this.fail("NO_CHAPTERS");
      this.chapters = chapters;
      this.detectionMode = "llm";
      this.setState(STATE.PREVIEW);
    } catch (e) {
      console.error(e);
      this.fail("LOAD_FAILED", "the local model failed to load: " + (e.message || e));
    }
  }

  async handle(file) {
    // Front-load the cheap checks so the user sees an error instantly rather
    // than after waiting for pdf.js (~1.7 MB) to download.
    if (!file || !file.name || !/\.pdf$/i.test(file.name)) {
      return this.fail("NOT_PDF");
    }
    const cap = isMobileUA() ? MAX_BROWSER_BYTES_MOBILE : MAX_BROWSER_BYTES_DESKTOP;
    if (file.size > cap) {
      return this.fail(isMobileUA() ? "TOO_LARGE_MOBILE" : "TOO_LARGE_DESKTOP");
    }
    this.fileName = file.name;
    this._cancelled = false;
    this._loadingTask = null;
    this.setState(STATE.PROCESSING, { pct: 4, status: "loading libraries…", filename: file.name });
    try {
      this.pdfBytes = await file.arrayBuffer();
      if (this._cancelled) return;
      const head = new Uint8Array(this.pdfBytes, 0, 5);
      const headStr = String.fromCharCode(...head);
      if (headStr !== "%PDF-") return this.fail("NOT_PDF");
    } catch (e) {
      if (this._cancelled) return;
      return this.fail("LOAD_FAILED", e.message);
    }

    // Detect already-bookmarked PDFs and warn.
    try {
      this.alreadyBookmarked = await pdfHasOutline(this.pdfBytes);
    } catch (_) { this.alreadyBookmarked = false; }
    if (this._cancelled) return;

    try {
      this.setState(STATE.PROCESSING, { pct: 10, status: "reading text…", filename: file.name });
      const { pages } = await extractPages(this.pdfBytes, (page, total) => {
        const pct = 10 + (page / total) * 60;
        this.setState(STATE.PROCESSING, { pct, status: `reading text · page ${page} / ${total}`, filename: file.name });
      }, {
        onLoadingTask: (lt) => { this._loadingTask = lt; },
        shouldCancel: () => !!this._cancelled,
      });
      if (this._cancelled) return;
      this.numPages = pages.length;

      const allText = pages.map(p => p.text).join("");
      if (allText.replace(/\s/g, "").length < 50) {
        this.cachedPages = pages;
        return this.fail("NO_TEXT");
      }

      this.cachedPages = pages;
      this.setState(STATE.PROCESSING, { pct: 76, status: "detecting chapters…", filename: file.name });
      const tocPages = findTOCPages(pages);
      let chapters = parseTOC(tocPages, pages);
      this.detectionMode = "toc";
      if (chapters.length < 2) {
        chapters = findHeadings(pages);
        this.detectionMode = "headings";
      }
      if (chapters.length < 1) return this.fail("NO_CHAPTERS");
      this.chapters = chapters;
      this.setState(STATE.PREVIEW);
    } catch (e) {
      if (this._cancelled || (e && e.code === "CANCELLED")) return;
      console.error(e);
      if (e && e.code === "ENCRYPTED") return this.fail("ENCRYPTED");
      if (e && /password|encrypt/i.test(e.message || "")) return this.fail("ENCRYPTED");
      this.fail("LOAD_FAILED", e.message);
    } finally {
      this._loadingTask = null;
    }
  }

  async confirm() {
    if (this.chapters.length === 0) return this.fail("NO_CHAPTERS");
    this.setState(STATE.PROCESSING, { pct: 92, status: "writing bookmarks…", filename: this.fileName });
    try {
      const bytes = await writeOutline(this.pdfBytes, this.chapters);
      downloadBytes(bytes, this.outputName());
      this.setState(STATE.DONE);
    } catch (e) {
      console.error(e);
      if (e && e.code === "ENCRYPTED") return this.fail("ENCRYPTED");
      this.fail("WRITE_FAILED", e.message);
    }
  }

  fail(code, message) {
    this.lastError = { code, message };
    this.setState(STATE.ERROR, { code, message });
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("walnut-app");
    if (root) new App(root);
  });
}

// Exports for the Node test harness.
export {
  App, STATE, ERR,
  TOC_LINE_RE, findTOCPages, parseTOC, findHeadings,
  resolvePageLabel, romanToInt, inferLevel, cleanTitle, dedupeChapters,
  writeOutline, extractPages, pdfHasOutline,
  pickCandidatePages, annotatePagesForLLM, LLM_MODEL_ID, LLM_MODEL_LABEL,
  hasWebGPU, isMobileUA,
};
