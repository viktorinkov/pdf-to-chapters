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
  TOO_LARGE_DESKTOP: "this file is over 500 MB. the browser version caps there to keep memory sane; the desktop version handles larger files.",
  TOO_LARGE_MOBILE: "this file is over 150 MB. mobile browsers run out of memory on bigger PDFs; try a desktop browser or the desktop version.",
  WRITE_FAILED: "could not write the outline. the PDF may be malformed.",
  LOAD_FAILED: "this PDF could not be opened.",
  MULTIPLE_FILES: "drop only one PDF at a time.",
  NOT_PDF: "that doesn't look like a PDF. drop a .pdf file.",
});

function isMobileUA() {
  return typeof navigator !== "undefined" && /Mobi|Android/i.test(navigator.userAgent || "");
}
const MAX_BROWSER_BYTES_DESKTOP = 500 * 1024 * 1024;
const MAX_BROWSER_BYTES_MOBILE  = 150 * 1024 * 1024;

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
  // The PDF's own page labels (e.g. "i".."xxiv", "1", "2", ...) when
  // /PageLabels is set. With these, TOC entries can be resolved exactly
  // instead of guessing the front-matter offset.
  let pageLabels = null;
  try {
    const got = await doc.getPageLabels();
    if (Array.isArray(got) && got.length === total) pageLabels = got;
  } catch (_) {}
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
        page_label: (pageLabels && pageLabels[i - 1]) || String(i),
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
  // Bucket items by ~4pt y-tolerance. PDFs sometimes baseline-shift a
  // right-aligned page number by 1-3pt vs the title in the same TOC row;
  // tighter buckets split them onto separate lines and break TOC parsing.
  const buckets = new Map();
  for (const it of items) {
    const key = Math.round(it.y / 4) * 4;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  const lines = [];
  for (const [y, group] of buckets) {
    group.sort((a, b) => a.x - b.x);
    // Join items using their x-position to recover word and column gaps.
    // Without this, "It's", "your", "choice!" with no trailing spaces in the
    // PDF stream collapses to "It'syourchoice!", and TOC entries like
    // "1   OVERVIEW   3" lose the leader-gap that the dot/whitespace regex
    // depends on.
    let text = "";
    let prevEnd = null;
    for (const it of group) {
      const itText = it.text;
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        const charW = Math.max(2, it.font_size * 0.4);
        if (gap > charW * 1.5) {
          // Column-sized gap: insert proportional whitespace so the dot-
          // leader regex can match. Capped to avoid runaway lines.
          const spaces = Math.min(40, Math.max(3, Math.round(gap / charW)));
          text += " ".repeat(spaces);
        } else if (gap > charW * 0.25) {
          text += " ";
        }
      }
      text += itText;
      const itWidth = it.width || (itText.length * (it.font_size * 0.5));
      prevEnd = it.x + itWidth;
    }
    text = text.replace(/[ \t]+$/, "");
    if (!text.trim()) continue;
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
  // Accept doubled dots from OCR-style extraction artifacts ("2..5.1" should
  // still be a level-3 section under 2.5, not a level-1 stray).
  const m = title.match(/^(\d+)((?:\.+\d+){0,2})/);
  if (m) {
    const groups = (m[2].match(/\.+\d+/g) || []).length;
    return Math.min(3, groups + 1);
  }
  return 1;
}

function cleanTitle(title) {
  // The regex that captured this title already stripped the trailing leader
  // and page number, so we only need to normalize spacing. We also strip a
  // dangling dot leader if one slipped through (e.g. "Foo .... ").
  return title
    .replace(/[\s.…]{3,}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
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

// WeakMap caches the printed-label -> physical-index map for a `pages` array
// so that we walk every page only once even when parseTOC calls resolve
// thousands of times.
const _inferredLabelCache = new WeakMap();
const _labelMapCache = new WeakMap();

function _getLabelMap(pages) {
  let m = _labelMapCache.get(pages);
  if (m) return m;
  m = new Map();
  // Only populate the map when the PDF supplied real /PageLabels. If every
  // page's label is just String(idx+1), it's the synthesized fallback from
  // extractPages and matching against it would short-circuit the inferred-
  // label path and return wrong physical indices for books with front matter.
  let hasReal = false;
  for (const p of pages) {
    if (String(p.page_label) !== String(p.page_idx + 1)) { hasReal = true; break; }
  }
  if (hasReal) {
    for (const p of pages) {
      const k = String(p.page_label).trim().toLowerCase();
      if (!m.has(k)) m.set(k, p.page_idx);
    }
  }
  _labelMapCache.set(pages, m);
  return m;
}

function _inferPrintedLabels(pages) {
  let cached = _inferredLabelCache.get(pages);
  if (cached) return cached;
  const map = new Map();
  for (const p of pages) {
    if (p.lines.length === 0) continue;
    // Pick the top-most line that's not a heading-sized chapter number.
    let line = p.lines[0];
    if (line.font_size > 14 && p.lines.length > 1) line = p.lines[1];
    if (line.font_size > 14) continue;
    const label = _pluckLabelFromLine(line.text);
    if (label && !map.has(label)) map.set(label, p.page_idx);
  }
  _inferredLabelCache.set(pages, map);
  return map;
}

function _pluckLabelFromLine(text) {
  text = String(text || "").trim();
  if (!text) return null;
  // Only consider the first token of a header line. The last-token branch
  // looks tempting, but TOC entries like "1.5.3 Data Independence 15" would
  // claim "15" -> tocPageIdx and pollute the map for downstream lookups.
  const first = text.split(/\s+/)[0] || "";
  if (/^\d{1,4}$/.test(first)) return first;
  if (/^[ivxlcdm]{1,8}$/i.test(first)) return first.toLowerCase();
  return null;
}

const _bodyOffsetCache = new WeakMap();

function _bodyOffset(pages) {
  if (_bodyOffsetCache.has(pages)) return _bodyOffsetCache.get(pages);
  const inferred = _inferPrintedLabels(pages);
  // Compute offset = physical_idx - (printed - 1) for each plausible
  // arabic anchor, then take the mode. Real folios across the body all
  // agree on the same offset; spurious matches scatter and lose to it.
  const counts = new Map();
  for (const [lbl, idx] of inferred) {
    const n = parseInt(lbl, 10);
    if (!Number.isFinite(n) || n < 1 || n > pages.length) continue;
    const off = idx - (n - 1);
    if (off < 0 || off > pages.length) continue;
    counts.set(off, (counts.get(off) || 0) + 1);
  }
  let bestOff = null;
  let bestCount = 0;
  for (const [off, c] of counts) {
    if (c > bestCount || (c === bestCount && bestOff !== null && off < bestOff)) {
      bestCount = c;
      bestOff = off;
    }
  }
  // Require at least 3 agreeing anchors before trusting an offset; fewer
  // suggests we're guessing on a tiny PDF or one with no header folios.
  if (bestCount < 3) bestOff = null;
  _bodyOffsetCache.set(pages, bestOff);
  return bestOff;
}

function resolvePageLabel(label, pages) {
  const norm = String(label).trim().toLowerCase();

  // 1) Exact match against the PDF's own /PageLabels (when present).
  const lblMap = _getLabelMap(pages);
  if (lblMap.has(norm)) return lblMap.get(norm);

  const arabic = parseInt(label, 10);
  if (Number.isFinite(arabic)) {
    // 2a) For arabic labels, project from the consensus front-matter offset.
    //     This is more robust than per-label inferred-map lookup, which can
    //     pick up false positives ("1" appears as the first token of many
    //     pages besides printed-page-1).
    const offset = _bodyOffset(pages);
    if (offset !== null) {
      const cand = offset + (arabic - 1);
      if (cand >= 0 && cand < pages.length) return cand;
    }
    // 2b) Fall back to the inferred map's individual entry if the consensus
    //     offset is unknown (small PDFs without enough body folios).
    const inferred = _inferPrintedLabels(pages);
    if (inferred.has(norm)) return inferred.get(norm);
    // 3) Last resort: naive 1:1 (works for PDFs with no front matter).
    if (arabic >= 1 && arabic <= pages.length) return arabic - 1;
    return Math.min(Math.max(0, arabic - 1), pages.length - 1);
  }

  // Roman labels (front-matter): the inferred map is reliable here because
  // few pages legitimately start with a roman-only first token.
  const inferred = _inferPrintedLabels(pages);
  if (inferred.has(norm)) return inferred.get(norm);
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
//
// Two writers:
//   - writeOutlineIncremental: pure-JS PDF incremental update. Reads only
//     the trailer, catalog, and page tree from raw bytes; never parses the
//     body. Memory is O(outline size), independent of input size. Output is
//     byte-identical to the input plus an appended region.
//   - writeOutlinePdfLib: the original pdf-lib path. Loads the entire PDF
//     into JS objects (memory ~5-10x file size). Used as a fallback when
//     the incremental path raises.

// ---- byte / latin-1 helpers ------------------------------------------

function _latin1FromBytes(bytes, start, end) {
  // Treat each byte as a code point. PDF syntax outside string/stream
  // contents is always 7-bit ASCII / Latin-1 safe.
  if (start === undefined) start = 0;
  if (end === undefined) end = bytes.length;
  let s = "";
  // Chunked to avoid call stack issues for very large files.
  const CHUNK = 0x8000;
  for (let i = start; i < end; i += CHUNK) {
    const stop = Math.min(end, i + CHUNK);
    s += String.fromCharCode.apply(null, bytes.subarray(i, stop));
  }
  return s;
}

// Cache the latin-1 projection and the indirect-object index per Uint8Array.
// Without this, _findIndirectObject re-allocates a string the size of the
// whole file on every call, which is O(N pages * file size) and turns a
// 50 MB write into ~60 seconds. With these caches, the same write completes
// in a fraction of a second.
const _latin1FullCache = new WeakMap();
const _objIndexCache   = new WeakMap();

function _latin1Full(bytes) {
  let cached = _latin1FullCache.get(bytes);
  if (cached === undefined) {
    cached = _latin1FromBytes(bytes, 0, bytes.length);
    _latin1FullCache.set(bytes, cached);
  }
  return cached;
}

function _buildObjIndex(bytes) {
  let cached = _objIndexCache.get(bytes);
  if (cached !== undefined) return cached;
  const text = _latin1Full(bytes);
  const map = new Map();
  // Same anchoring as the original per-object regex: preceded by start-of-
  // file or a whitespace char so we don't match "5 0 obj" embedded in a
  // string. m[1] is "" (BOL) or one whitespace char.
  const re = /(^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const objStart = m.index + m[1].length;
    const num = parseInt(m[2], 10);
    const gen = parseInt(m[3], 10);
    const key = num + "/" + gen;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(objStart);
  }
  _objIndexCache.set(bytes, map);
  return map;
}

function _bytesFromLatin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function _utf16beHexFromString(s) {
  // PDF /Title hex string with UTF-16BE BOM, suitable for any Unicode title.
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    hex += ((c >> 8) & 0xff).toString(16).padStart(2, "0").toUpperCase();
    hex += (c & 0xff).toString(16).padStart(2, "0").toUpperCase();
  }
  return "<" + hex + ">";
}

function _padLeft(n, width, pad) {
  let s = String(n);
  if (pad === undefined) pad = "0";
  while (s.length < width) s = pad + s;
  return s;
}

// ---- trailer / xref parsing ------------------------------------------

function _findStartXref(bytes) {
  // Read up to the last ~64 KB. The spec only requires <1024, but being
  // generous costs nothing and tolerates files with appended garbage.
  const tailSize = Math.min(bytes.length, 65536);
  const tail = _latin1FromBytes(bytes, bytes.length - tailSize, bytes.length);
  // Find the LAST occurrence of startxref (handles already-incremental files).
  const idx = tail.lastIndexOf("startxref");
  if (idx < 0) throw new Error("no startxref marker found");
  // After startxref: optional whitespace, integer, whitespace, %%EOF.
  const m = tail.slice(idx).match(/startxref\s+(\d+)\s*%%EOF/);
  if (!m) throw new Error("malformed startxref/%%EOF marker");
  const startXrefOffset = parseInt(m[1], 10);
  if (!Number.isFinite(startXrefOffset) || startXrefOffset < 0 || startXrefOffset >= bytes.length) {
    throw new Error("startxref offset out of range: " + startXrefOffset);
  }
  return startXrefOffset;
}

function _readDictAt(bytes, openOffset) {
  // Returns {dict: <inner dict text including <<...>>>, end: offset just past >>}.
  // Handles nested dicts/arrays and string literals robustly enough for our
  // catalog and trailer needs.
  if (bytes[openOffset] !== 0x3c /* '<' */ || bytes[openOffset + 1] !== 0x3c) {
    throw new Error("expected '<<' at offset " + openOffset);
  }
  let i = openOffset + 2;
  let depth = 1;
  while (i < bytes.length) {
    const c = bytes[i];
    const c2 = bytes[i + 1];
    if (c === 0x3c && c2 === 0x3c) { depth++; i += 2; continue; }
    if (c === 0x3e && c2 === 0x3e) {
      depth--;
      i += 2;
      if (depth === 0) {
        return {
          text: _latin1FromBytes(bytes, openOffset, i),
          end: i,
        };
      }
      continue;
    }
    if (c === 0x28 /* '(' */) {
      // PDF literal string, balanced parens with backslash escapes.
      i++;
      let pdepth = 1;
      while (i < bytes.length && pdepth > 0) {
        const cc = bytes[i];
        if (cc === 0x5c) { i += 2; continue; }
        if (cc === 0x28) pdepth++;
        else if (cc === 0x29) pdepth--;
        i++;
      }
      continue;
    }
    if (c === 0x3c /* '<' but not '<<' */) {
      // hex string <FE...> — skip to matching >
      i++;
      while (i < bytes.length && bytes[i] !== 0x3e) i++;
      if (i < bytes.length) i++;
      continue;
    }
    i++;
  }
  throw new Error("unterminated dictionary starting at " + openOffset);
}

function _parseTrailerDict(text) {
  // Return {Root: {num,gen}, Size: N, Prev: offset|null, hasEncrypt: bool}
  // text is the inner dict including << ... >>.
  // We extract keys with simple regex; values may be:
  //   - <num> <gen> R  (indirect ref)
  //   - integer
  //   - /Name
  // /Root is always indirect, /Size is integer, /Prev is integer.
  const out = { Root: null, Size: null, Prev: null, hasEncrypt: false };
  // Strip outer << >> for matching.
  const inner = text.slice(2, text.length - 2);
  // /Root <n> <g> R
  const mRoot = inner.match(/\/Root\s+(\d+)\s+(\d+)\s+R/);
  if (mRoot) out.Root = { num: parseInt(mRoot[1], 10), gen: parseInt(mRoot[2], 10) };
  // /Size <n>
  const mSize = inner.match(/\/Size\s+(\d+)/);
  if (mSize) out.Size = parseInt(mSize[1], 10);
  // /Prev <n>
  const mPrev = inner.match(/\/Prev\s+(\d+)/);
  if (mPrev) out.Prev = parseInt(mPrev[1], 10);
  // /Encrypt presence
  if (/\/Encrypt\s+/.test(inner)) out.hasEncrypt = true;
  return out;
}

function _parseTrailerAndCatalog(bytes) {
  // Walk back through xref tables / streams, collecting offsets.
  // Returns {rootRef, size, prevXrefOffset, catalogObjOffset, catalogDictText, catalogObjEnd, hasEncrypt}.
  const startXrefOffset = _findStartXref(bytes);

  // Detect: at startXrefOffset, do we have "xref" (legacy) or an
  // indirect object header (xref stream)?
  const peek = _latin1FromBytes(bytes, startXrefOffset, Math.min(bytes.length, startXrefOffset + 32));
  let trailer = null;

  if (/^xref\b/.test(peek)) {
    // legacy xref TABLE
    trailer = _parseLegacyXrefTrailer(bytes, startXrefOffset);
  } else if (/^\d+\s+\d+\s+obj/.test(peek)) {
    // xref STREAM
    trailer = _parseXrefStreamTrailer(bytes, startXrefOffset);
  } else {
    throw new Error("unrecognized xref structure at offset " + startXrefOffset);
  }

  if (trailer.hasEncrypt) {
    const err = new Error("encrypted");
    err.code = "ENCRYPTED";
    throw err;
  }
  if (!trailer.Root) throw new Error("trailer has no /Root");
  if (!trailer.Size) throw new Error("trailer has no /Size");

  // Now find the catalog object body.
  const catalog = _findIndirectObject(bytes, trailer.Root.num, trailer.Root.gen);
  return {
    rootRef: trailer.Root,
    size: trailer.Size,
    prevXrefOffset: startXrefOffset,
    catalogObjOffset: catalog.objStart,
    catalogObjEnd: catalog.objEnd,
    catalogDictText: catalog.dictText,
    catalogDictEnd: catalog.dictEnd,
  };
}

function _parseLegacyXrefTrailer(bytes, xrefStart) {
  // Locate "trailer" keyword after the xref table.
  const tail = _latin1FromBytes(bytes, xrefStart, bytes.length);
  const trIdx = tail.indexOf("trailer");
  if (trIdx < 0) throw new Error("legacy xref: no trailer keyword");
  // Trailer dict starts at the next "<<".
  const dictAbsOffset = xrefStart + tail.indexOf("<<", trIdx);
  if (dictAbsOffset < xrefStart) throw new Error("legacy xref: trailer dict not found");
  const { text } = _readDictAt(bytes, dictAbsOffset);
  return _parseTrailerDict(text);
}

function _parseXrefStreamTrailer(bytes, xrefStart) {
  // The xref stream is an indirect object: "<num> <gen> obj <<...>> stream ... endstream endobj"
  // We only need the dict (before "stream"). It contains /Root /Size /Prev etc.
  // Find "<<" after the obj header.
  const tail = _latin1FromBytes(bytes, xrefStart, Math.min(bytes.length, xrefStart + 16384));
  const mObj = tail.match(/^(\d+)\s+(\d+)\s+obj\s*/);
  if (!mObj) throw new Error("xref stream: missing obj header");
  const after = mObj[0].length;
  const dictRel = tail.indexOf("<<", after);
  if (dictRel < 0) throw new Error("xref stream: no dict");
  const dictAbs = xrefStart + dictRel;
  const { text } = _readDictAt(bytes, dictAbs);
  return _parseTrailerDict(text);
}

function _findIndirectObject(bytes, num, gen) {
  // Look up candidate offsets in the cached object index, then validate each
  // by checking that "<<" follows the obj marker. The index is built once per
  // bytes Uint8Array via _buildObjIndex(), so subsequent lookups are O(1).
  const map = _buildObjIndex(bytes);
  const candidates = map.get(num + "/" + gen);
  if (!candidates || candidates.length === 0) {
    throw new Error("indirect object " + num + " " + gen + " not found");
  }
  for (const objStart of candidates) {
    // Skip past "<num> <gen> obj" to land at the object body.
    let i = objStart;
    // num
    while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09)) i++;
    // gen
    while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09)) i++;
    // "obj"
    if (bytes[i] !== 0x6f || bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a) continue;
    i += 3;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
    if (bytes[i] !== 0x3c || bytes[i + 1] !== 0x3c) continue;
    let dictInfo;
    try {
      dictInfo = _readDictAt(bytes, i);
    } catch (_) {
      continue;
    }
    // Look ahead a few bytes to detect a stream object. We cap the latin-1
    // slice at 64 bytes so this stays cheap even for huge files.
    const sliceEnd = Math.min(bytes.length, dictInfo.end + 64);
    const after = _latin1FromBytes(bytes, dictInfo.end, sliceEnd);
    const isStream = /^\s*stream/.test(after);
    let objEnd = dictInfo.end;
    if (isStream) {
      const fullText = _latin1Full(bytes);
      const endObjIdx = fullText.indexOf("endobj", dictInfo.end);
      if (endObjIdx > 0) objEnd = endObjIdx + "endobj".length;
    } else {
      const endObjIdx = after.indexOf("endobj");
      if (endObjIdx > 0) objEnd = dictInfo.end + endObjIdx + "endobj".length;
    }
    return {
      objStart,
      objEnd,
      dictText: dictInfo.text,
      dictStart: i,
      dictEnd: dictInfo.end,
      isStream,
    };
  }
  throw new Error("indirect object " + num + " " + gen + " not parseable");
}

// ---- catalog dict editing --------------------------------------------

function _stripDictKey(innerDict, key) {
  // Remove a /Key value pair from an inner dict text (without surrounding << >>).
  // We tokenize to "find next key" and remove [keyStart..nextKeyStart).
  // Returns the modified inner text.
  const re = new RegExp("\\/" + key + "\\b");
  const m = re.exec(innerDict);
  if (!m) return innerDict;
  const keyStart = m.index;
  // Walk forward past the key to find the start of the value.
  let i = keyStart + m[0].length;
  // Skip whitespace.
  while (i < innerDict.length && /\s/.test(innerDict[i])) i++;
  // Now skip exactly one PDF value: a name, integer, ref (n g R), name, hex/literal string, dict, or array.
  i = _skipPdfValue(innerDict, i);
  // Skip trailing whitespace.
  while (i < innerDict.length && /\s/.test(innerDict[i])) i++;
  return innerDict.slice(0, keyStart) + innerDict.slice(i);
}

function _skipPdfValue(s, start) {
  let i = start;
  if (i >= s.length) return i;
  const c = s[i];
  if (c === "<") {
    if (s[i + 1] === "<") {
      // dict
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "<" && s[i + 1] === "<") { depth++; i += 2; }
        else if (s[i] === ">" && s[i + 1] === ">") { depth--; i += 2; }
        else if (s[i] === "(") { i = _skipParenString(s, i); }
        else if (s[i] === "<") {
          // hex string
          while (i < s.length && s[i] !== ">") i++;
          if (i < s.length) i++;
        } else i++;
      }
      return i;
    } else {
      // hex string
      while (i < s.length && s[i] !== ">") i++;
      if (i < s.length) i++;
      return i;
    }
  }
  if (c === "[") {
    let depth = 1;
    i++;
    while (i < s.length && depth > 0) {
      if (s[i] === "[") depth++;
      else if (s[i] === "]") depth--;
      else if (s[i] === "(") { i = _skipParenString(s, i); continue; }
      else if (s[i] === "<" && s[i + 1] === "<") {
        // nested dict — skip recursively
        i = _skipPdfValue(s, i);
        continue;
      } else if (s[i] === "<") {
        while (i < s.length && s[i] !== ">") i++;
      }
      i++;
    }
    return i;
  }
  if (c === "(") return _skipParenString(s, i);
  if (c === "/") {
    i++;
    // Name: terminated by whitespace or delimiter.
    while (i < s.length && !/[\s\/<>\[\]()]/.test(s[i])) i++;
    return i;
  }
  // Number / boolean / null / indirect ref. Try to detect "n g R".
  const numRe = /^[+\-]?[\d.]+/;
  const m1 = s.slice(i).match(numRe);
  if (m1) {
    let j = i + m1[0].length;
    // Could be "n g R": look ahead.
    const refMatch = s.slice(j).match(/^\s+\d+\s+R\b/);
    if (refMatch) j += refMatch[0].length;
    return j;
  }
  // bool / null
  const m2 = s.slice(i).match(/^(true|false|null)\b/);
  if (m2) return i + m2[0].length;
  // Unknown: advance one char to avoid infinite loop.
  return i + 1;
}

function _skipParenString(s, start) {
  let i = start + 1;
  let depth = 1;
  while (i < s.length && depth > 0) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    i++;
  }
  return i;
}

function _reviseCatalogDict(catalogDictText, outlinesRef) {
  // catalogDictText starts with "<<" and ends with ">>". Strip any existing
  // /Outlines and /PageMode entries, then add our own before the closing ">>".
  let inner = catalogDictText.slice(2, catalogDictText.length - 2);
  inner = _stripDictKey(inner, "Outlines");
  inner = _stripDictKey(inner, "PageMode");
  // Trim trailing whitespace before closing.
  inner = inner.replace(/\s+$/, "");
  inner += "\n/Outlines " + outlinesRef.num + " " + outlinesRef.gen + " R";
  inner += "\n/PageMode /UseOutlines\n";
  return "<<" + inner + ">>";
}

// ---- page tree walking -----------------------------------------------

function _findRefValueInDict(innerDict, key) {
  // Find "/Key <n> <g> R" — return {num, gen} or null.
  const re = new RegExp("\\/" + key + "\\s+(\\d+)\\s+(\\d+)\\s+R\\b");
  const m = re.exec(innerDict);
  return m ? { num: parseInt(m[1], 10), gen: parseInt(m[2], 10) } : null;
}

function _findArrayValueInDict(innerDict, key) {
  // Find "/Key [...]" — return the inner array text (without brackets).
  const re = new RegExp("\\/" + key + "\\s*\\[");
  const m = re.exec(innerDict);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < innerDict.length && depth > 0) {
    if (innerDict[i] === "[") depth++;
    else if (innerDict[i] === "]") depth--;
    if (depth === 0) break;
    i++;
  }
  return innerDict.slice(start, i);
}

function _findNameInDict(innerDict, key) {
  // Find "/Key /Name" — return the name (without slash) or null.
  const re = new RegExp("\\/" + key + "\\s*\\/(\\w+)");
  const m = re.exec(innerDict);
  return m ? m[1] : null;
}

function _parseRefList(arrayText) {
  // Parse "<n> <g> R <n> <g> R ..." -> [{num, gen}, ...].
  const out = [];
  const re = /(\d+)\s+(\d+)\s+R/g;
  let m;
  while ((m = re.exec(arrayText)) !== null) {
    out.push({ num: parseInt(m[1], 10), gen: parseInt(m[2], 10) });
  }
  return out;
}

function _collectPageRefs(bytes, rootRef) {
  // Walk the page tree under /Catalog -> /Pages -> /Kids ...
  const catalog = _findIndirectObject(bytes, rootRef.num, rootRef.gen);
  const innerCatalog = catalog.dictText.slice(2, catalog.dictText.length - 2);
  const pagesRef = _findRefValueInDict(innerCatalog, "Pages");
  if (!pagesRef) throw new Error("catalog has no /Pages");

  const out = [];
  const seen = new Set();

  function walk(ref) {
    const key = ref.num + "/" + ref.gen;
    if (seen.has(key)) return;
    seen.add(key);
    let info;
    try {
      info = _findIndirectObject(bytes, ref.num, ref.gen);
    } catch (_) {
      return;
    }
    const inner = info.dictText.slice(2, info.dictText.length - 2);
    const type = _findNameInDict(inner, "Type");
    if (type === "Page") {
      out.push(ref);
      return;
    }
    if (type === "Pages" || _findArrayValueInDict(inner, "Kids")) {
      const kidsArr = _findArrayValueInDict(inner, "Kids");
      if (kidsArr) {
        const kids = _parseRefList(kidsArr);
        for (const kid of kids) walk(kid);
      }
      return;
    }
    // Fallback: treat as a leaf.
    out.push(ref);
  }

  walk(pagesRef);
  return out;
}

// ---- nested outline tree -----------------------------------------------

function _buildOutlineTree(chapters) {
  // Convert a flat [{title, level, physical_page_idx, ...}] list into a nested
  // tree. Levels start at 1; missing/invalid levels default to 1.
  const root = { children: [] };
  const stack = [root]; // stack[i] is the current parent at depth i+1's parent
  // stack[0] is root, stack[1] is parent for level-1 nodes, etc.
  // Convention: stack length grows by 1 when pushing a child.
  for (const ch of chapters) {
    let lvl = ch.level | 0;
    if (!Number.isFinite(lvl) || lvl < 1) lvl = 1;
    if (lvl > 3) lvl = 3;
    // Trim stack to depth lvl (so its top is the parent for this level).
    while (stack.length > lvl) stack.pop();
    while (stack.length < lvl) {
      // No previous parent at this level: attach to whatever's available.
      // (E.g. a level-2 entry appearing first.) Use the deepest available.
      const parent = stack[stack.length - 1];
      if (parent.children.length === 0) {
        // Promote: create a synthetic? No — just attach at this level.
        break;
      }
      stack.push(parent.children[parent.children.length - 1]);
    }
    const parent = stack[stack.length - 1];
    const node = { chapter: ch, level: lvl, children: [] };
    parent.children.push(node);
    // Push this node so subsequent deeper levels can attach.
    stack.push(node);
  }
  return root.children;
}

function _flattenTreeBFS(nodes) {
  // Walk depth-first to assign object refs in document order.
  const out = [];
  function walk(arr) {
    for (const n of arr) {
      out.push(n);
      walk(n.children);
    }
  }
  walk(nodes);
  return out;
}

function _countDescendants(node) {
  // The PDF /Count for an outline item is the total number of its visible
  // (open) descendants. We mark all items "open" to keep the panel expanded.
  let n = node.children.length;
  for (const c of node.children) n += _countDescendants(c);
  return n;
}

function _annotateTree(roots, parentNode) {
  // Set parent / prev / next pointers on every node in the tree so the
  // writer can emit /Parent, /Prev, /Next links without re-walking.
  for (let i = 0; i < roots.length; i++) {
    const node = roots[i];
    node.parent = parentNode || null;
    node.prev = i > 0 ? roots[i - 1] : null;
    node.next = i < roots.length - 1 ? roots[i + 1] : null;
    _annotateTree(node.children, node);
  }
}

// ---- incremental writer ----------------------------------------------

async function writeOutlineIncremental(originalBytes, chapters) {
  // Coerce to Uint8Array so we can index bytes consistently. Do not copy if
  // already a Uint8Array (this is the whole point — we preserve the original
  // bytes byte-for-byte and append).
  let bytes = originalBytes;
  if (bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(bytes);
  } else if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes);
  }
  if (bytes.length < 32) throw new Error("file too small to be a PDF");
  // Quick header check.
  const header = _latin1FromBytes(bytes, 0, 5);
  if (header !== "%PDF-") throw new Error("not a PDF");

  // 1. Parse the trailer to find /Root, /Size, /Prev xref offset.
  const tc = _parseTrailerAndCatalog(bytes);
  if (!chapters || chapters.length === 0) throw new Error("no chapters to write");

  // 2. Walk the page tree.
  const pageRefs = _collectPageRefs(bytes, tc.rootRef);
  if (pageRefs.length === 0) throw new Error("no pages found in PDF");

  // 3. Build the outline tree and assign object numbers.
  const tree = _buildOutlineTree(chapters);
  if (tree.length === 0) throw new Error("outline tree is empty");
  const flat = _flattenTreeBFS(tree);
  // Object number for the new outlines root: tc.size, then items: tc.size+1..
  const outlinesObjNum = tc.size;
  const itemBaseObjNum = tc.size + 1;
  for (let i = 0; i < flat.length; i++) {
    flat[i].objNum = itemBaseObjNum + i;
  }
  // Also reserve a number for the revised catalog: we re-emit the catalog
  // at its existing num/gen as a revision (no new number needed).

  // 4. Compute page targets for each item.
  for (const item of flat) {
    const idx = Math.min(Math.max(0, item.chapter.physical_page_idx | 0), pageRefs.length - 1);
    item.pageRef = pageRefs[idx];
  }

  // 5. Emit object bodies as latin-1 strings, computing offsets.
  // We build a combined latin-1 string for the appended region, then
  // measure offsets within it. The original file's length is the base.
  const baseOffset = bytes.length;
  let region = "";

  // Pad with a single newline so that startxref offsets aren't ambiguous.
  // Spec doesn't require it, but Adobe and most readers expect a clean
  // separation between the original EOF and the new section.
  region += "\n";

  // 5a. Item objects.
  const itemOffsets = new Map(); // objNum -> offset
  for (const item of flat) {
    const offset = baseOffset + region.length;
    itemOffsets.set(item.objNum, offset);
    const titleHex = _utf16beHexFromString(String(item.chapter.title || ""));
    let body = item.objNum + " 0 obj\n";
    body += "<<\n";
    body += "/Title " + titleHex + "\n";
    // Parent: the immediate parent node, or the outlines root if a top-level item.
    // Determine parent: we walk the tree; for that we need to know each node's parent.
    // We'll fill in parents below by index.
    // PLACEHOLDER — we'll rewrite this loop after building parent map.
    body += "__PARENT__\n";
    body += "/Dest [" + item.pageRef.num + " " + item.pageRef.gen + " R /Fit]\n";
    body += "__SIBLINGS__\n";
    body += "__CHILDREN__\n";
    body += ">>\nendobj\n";
    item._body = body;
  }

  // Build parent / sibling / children references using the tree directly.
  // Top-level nodes have parent = outlines root.
  function fillItem(node, parentObjNum, prevSibling, nextSibling) {
    let parent = "/Parent " + parentObjNum + " 0 R";
    let siblings = "";
    if (prevSibling) siblings += "/Prev " + prevSibling.objNum + " 0 R\n";
    if (nextSibling) siblings += "/Next " + nextSibling.objNum + " 0 R\n";
    siblings = siblings.trimEnd();
    let children = "";
    if (node.children.length > 0) {
      const first = node.children[0];
      const last  = node.children[node.children.length - 1];
      children += "/First " + first.objNum + " 0 R\n";
      children += "/Last " + last.objNum + " 0 R\n";
      // Negative count if collapsed; positive (or absent) if expanded.
      // We pick a positive count to keep the panel expanded by default.
      const cnt = _countDescendants(node);
      if (cnt > 0) children += "/Count " + cnt;
    }
    children = children.trimEnd();
    let body = node._body
      .replace("__PARENT__", parent)
      .replace("__SIBLINGS__", siblings || "")
      .replace("__CHILDREN__", children || "");
    // Clean up empty placeholder lines.
    body = body.replace(/\n\n+/g, "\n");
    node._body = body;
  }

  function fillSiblings(siblings, parentObjNum) {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      const prev = i > 0 ? siblings[i - 1] : null;
      const next = i < siblings.length - 1 ? siblings[i + 1] : null;
      fillItem(node, parentObjNum, prev, next);
      if (node.children.length > 0) {
        fillSiblings(node.children, node.objNum);
      }
    }
  }
  fillSiblings(tree, outlinesObjNum);

  // Rebuild region from scratch now that bodies are filled in.
  region = "\n";
  itemOffsets.clear();
  for (const item of flat) {
    const offset = baseOffset + region.length;
    itemOffsets.set(item.objNum, offset);
    region += item._body;
  }

  // 5b. Outlines root object.
  const outlinesOffset = baseOffset + region.length;
  let outlinesBody = outlinesObjNum + " 0 obj\n<<\n/Type /Outlines\n";
  if (tree.length > 0) {
    outlinesBody += "/First " + tree[0].objNum + " 0 R\n";
    outlinesBody += "/Last "  + tree[tree.length - 1].objNum + " 0 R\n";
    // /Count: total number of visible descendants. With everything open, that's
    // every node in the tree.
    let totalVisible = 0;
    for (const t of tree) totalVisible += 1 + _countDescendants(t);
    outlinesBody += "/Count " + totalVisible + "\n";
  }
  outlinesBody += ">>\nendobj\n";
  region += outlinesBody;

  // 5c. Revised catalog object (same num/gen as the original).
  const catalogOffset = baseOffset + region.length;
  const newCatalogDict = _reviseCatalogDict(tc.catalogDictText, { num: outlinesObjNum, gen: 0 });
  const catalogBody =
    tc.rootRef.num + " " + tc.rootRef.gen + " obj\n" +
    newCatalogDict + "\nendobj\n";
  region += catalogBody;

  // 6. Build the xref subsections. Spec requires: subsections grouped by
  // contiguous object numbers; entry 0 of object 0 only when included.
  // Our updated objects: the catalog (rootRef.num) plus item objects
  // [outlinesObjNum .. outlinesObjNum + flat.length] — the outlines root
  // and all item objects are contiguous by construction.
  const updates = []; // {num, offset, gen}
  // The revised catalog lives at catalogOffset (in the appended region),
  // NOT at tc.catalogObjOffset (the original offset in the input file).
  updates.push({ num: tc.rootRef.num, offset: catalogOffset, gen: tc.rootRef.gen });
  // Outlines root + items.
  updates.push({ num: outlinesObjNum, offset: outlinesOffset, gen: 0 });
  for (const item of flat) {
    updates.push({ num: item.objNum, offset: itemOffsets.get(item.objNum), gen: 0 });
  }
  updates.sort((a, b) => a.num - b.num);

  // Group into contiguous subsections.
  const subsections = [];
  let cur = null;
  for (const u of updates) {
    if (!cur || u.num !== cur.start + cur.entries.length) {
      cur = { start: u.num, entries: [] };
      subsections.push(cur);
    }
    cur.entries.push(u);
  }

  const xrefOffset = baseOffset + region.length;
  let xref = "xref\n";
  for (const sub of subsections) {
    xref += sub.start + " " + sub.entries.length + "\n";
    for (const e of sub.entries) {
      xref += _padLeft(e.offset, 10) + " " + _padLeft(e.gen, 5) + " n \n";
    }
  }
  region += xref;

  // 7. Trailer + startxref + EOF.
  const newSize = Math.max(tc.size, (outlinesObjNum + flat.length + 1));
  let trailer = "trailer\n<<\n";
  trailer += "/Size " + newSize + "\n";
  trailer += "/Root " + tc.rootRef.num + " " + tc.rootRef.gen + " R\n";
  trailer += "/Prev " + tc.prevXrefOffset + "\n";
  trailer += ">>\n";
  trailer += "startxref\n" + xrefOffset + "\n%%EOF\n";
  region += trailer;

  // 8. Concatenate and return. Sanity: prefix must equal original bytes.
  const regionBytes = _bytesFromLatin1(region);
  const out = new Uint8Array(bytes.length + regionBytes.length);
  out.set(bytes, 0);
  out.set(regionBytes, bytes.length);

  // Sanity invariants — these must hold by construction; if they don't, the
  // writer has a bug we want to catch loudly rather than silently corrupt
  // the user's file.
  if (out.length < bytes.length) throw new Error("incremental write produced shorter output");
  // %%EOF should be at the very end (modulo a single optional newline).
  const tail = _latin1FromBytes(out, Math.max(0, out.length - 16), out.length);
  if (tail.indexOf("%%EOF") < 0) throw new Error("incremental write missing trailing %%EOF");
  // /Size in the new trailer covers original size plus all newly written
  // objects (item objects + outlines root + the revised catalog occupies
  // its existing slot, not a new number).
  if (newSize < tc.size + flat.length + 1) {
    throw new Error("incremental write: /Size invariant failed");
  }

  return out;
}

// ---- pdf-lib fallback writer -----------------------------------------

async function writeOutlinePdfLib(pdfBytes, chapters) {
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

  // Build the nested tree from the flat chapter list using the chapter
  // levels (1 = part/chapter, 2 = section, 3 = sub-section). Annotate it
  // with parent / prev / next pointers so we can emit links in one pass.
  const tree = _buildOutlineTree(chapters);
  if (tree.length === 0) throw new Error("no chapters to write");
  _annotateTree(tree, null);
  const flat = _flattenTreeBFS(tree);

  // Allocate refs.
  for (const node of flat) node.ref = ctx.nextRef();
  const outlinesRef = ctx.nextRef();

  for (const node of flat) {
    const ch = node.chapter;
    const idx = Math.min(Math.max(0, ch.physical_page_idx | 0), pages.length - 1);
    const page = pages[idx];
    const dest = PDFArray.withContext(ctx);
    // [pageRef, /Fit] — open the page fitted to the viewer window.
    dest.push(page.ref);
    dest.push(PDFName.of("Fit"));
    const fields = new Map();
    fields.set(PDFName.of("Title"), PDFHexString.fromText(String(ch.title || "")));
    fields.set(PDFName.of("Parent"), node.parent ? node.parent.ref : outlinesRef);
    fields.set(PDFName.of("Dest"), dest);
    if (node.prev) fields.set(PDFName.of("Prev"), node.prev.ref);
    if (node.next) fields.set(PDFName.of("Next"), node.next.ref);
    if (node.children.length > 0) {
      fields.set(PDFName.of("First"), node.children[0].ref);
      fields.set(PDFName.of("Last"), node.children[node.children.length - 1].ref);
      // Positive Count = expanded by default (panel opens with sections visible).
      fields.set(PDFName.of("Count"), PDFNumber.of(_countDescendants(node)));
    }
    const itemDict = PDFDict.fromMapWithContext(fields, ctx);
    ctx.assign(node.ref, itemDict);
  }

  const outlinesFields = new Map();
  outlinesFields.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlinesFields.set(PDFName.of("First"), tree[0].ref);
  outlinesFields.set(PDFName.of("Last"),  tree[tree.length - 1].ref);
  // Root /Count = total visible descendants (sum of 1 + descendants over
  // top-level nodes), positive so the panel expands the whole tree.
  let rootCount = 0;
  for (const top of tree) rootCount += 1 + _countDescendants(top);
  outlinesFields.set(PDFName.of("Count"), PDFNumber.of(rootCount));
  ctx.assign(outlinesRef, PDFDict.fromMapWithContext(outlinesFields, ctx));

  pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  // Auto-open the outline panel when readers open the file.
  pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  return await pdfDoc.save({ useObjectStreams: false });
}

// ---- public entry point ----------------------------------------------

async function writeOutline(pdfBytes, chapters) {
  // Prefer the incremental writer (memory: O(outline size)). Fall back to
  // pdf-lib (which loads the whole PDF) for cases the incremental writer
  // can't handle — encrypted, malformed structure, exotic xref shapes.
  try {
    return await writeOutlineIncremental(pdfBytes, chapters);
  } catch (e) {
    if (e && e.code === "ENCRYPTED") throw e;
    if (typeof console !== "undefined" && console.warn) {
      console.warn("incremental update failed, falling back to pdf-lib:", e && e.message ? e.message : e);
    }
    return await writeOutlinePdfLib(pdfBytes, chapters);
  }
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
  writeOutline, writeOutlineIncremental, writeOutlinePdfLib,
  extractPages, pdfHasOutline,
  pickCandidatePages, annotatePagesForLLM, LLM_MODEL_ID, LLM_MODEL_LABEL,
  hasWebGPU, isMobileUA,
  MAX_BROWSER_BYTES_DESKTOP, MAX_BROWSER_BYTES_MOBILE,
};
