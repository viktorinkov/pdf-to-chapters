// Fixture PDF generation for Playwright e2e tests.
//
// Mirrors scripts/test_browser.mjs::buildFixture so the e2e tests exercise
// the same kind of synthetic 12-page book that the Node smoke test uses.
//
// Also exposes makeLargeFixturePDF() — a deterministic synthetic book of
// ~targetMB megabytes used to exercise the large-file code path in both the
// Playwright e2e suite (8 MB) and the Node-side benchmark (50 MB). The
// content is generated procedurally with a fixed PRNG seed so size and
// structure are stable across runs.

import { PDFDocument, StandardFonts, PDFName, PDFArray, PDFHexString, PDFNumber, PDFDict } from "pdf-lib";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Build a 12-page PDF with:
 *   page 0  - title
 *   page 1  - copyright
 *   page 2  - "Contents" + 3 TOC rows with leader dots and printed labels
 *   page 3  - chapter 1 starts (printed page 4)
 *   page 4-5 - body
 *   page 6  - chapter 2 starts (printed page 7)
 *   page 7-8 - body
 *   page 9  - chapter 3 starts (printed page 10)
 *   page 10-11 - body
 */
export async function buildFixturePDF() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612;
  const H = 792;

  function newPage() {
    return doc.addPage([W, H]);
  }

  function place(page, y, text, font, size) {
    page.drawText(text, { x: 72, y: H - y, size, font });
  }

  // page 0 - title
  let p = newPage();
  place(p, 200, "A Walnut Story", helvB, 28);
  place(p, 240, "by Test Author", helv, 14);

  // page 1 - copyright
  p = newPage();
  place(p, 100, "Copyright 2026", helv, 10);

  // page 2 - TOC
  p = newPage();
  place(p, 80, "Contents", helvB, 20);
  const leader = ".".repeat(40);
  place(p, 130, `Chapter 1: The Arrival ${leader} 4`, helv, 11);
  place(p, 160, `Chapter 2: The Journey ${leader} 7`, helv, 11);
  place(p, 190, `Chapter 3: The Return  ${leader} 10`, helv, 11);

  // page 3 - chapter 1 (printed page 4)
  p = newPage();
  place(p, 100, "Chapter 1: The Arrival", helvB, 18);
  place(p, 140, "It was a dark and stormy night when our hero arrived.", helv, 11);

  // page 4 - body
  p = newPage();
  place(p, 100, "More body text for chapter 1.", helv, 11);

  // page 5 - body
  p = newPage();
  place(p, 100, "Even more body text.", helv, 11);

  // page 6 - chapter 2 (printed page 7)
  p = newPage();
  place(p, 100, "Chapter 2: The Journey", helvB, 18);
  place(p, 140, "The road was long and the company strange.", helv, 11);

  // pages 7-8 - body
  for (let i = 0; i < 2; i++) {
    p = newPage();
    place(p, 100, "More body text.", helv, 11);
  }

  // page 9 - chapter 3 (printed page 10)
  p = newPage();
  place(p, 100, "Chapter 3: The Return", helvB, 18);
  place(p, 140, "All things must come to an end.", helv, 11);

  // pages 10-11 - closing pages
  for (let i = 0; i < 2; i++) {
    p = newPage();
    place(p, 100, "Closing pages.", helv, 11);
  }

  return await doc.save();
}

/**
 * Build the same fixture PDF, but pre-stamp it with an /Outlines dictionary
 * so the app shows a "this PDF already has bookmarks" warning on the preview
 * screen. We use a minimal single-entry outline pointing at the first page.
 */
export async function buildBookmarkedFixturePDF() {
  const u8 = await buildFixturePDF();
  const pdfDoc = await PDFDocument.load(u8);
  const ctx = pdfDoc.context;
  const pages = pdfDoc.getPages();

  const itemRef = ctx.nextRef();
  const outlinesRef = ctx.nextRef();

  const dest = PDFArray.withContext(ctx);
  dest.push(pages[0].ref);
  dest.push(PDFName.of("Fit"));

  const itemFields = new Map();
  itemFields.set(PDFName.of("Title"), PDFHexString.fromText("Existing Bookmark"));
  itemFields.set(PDFName.of("Parent"), outlinesRef);
  itemFields.set(PDFName.of("Dest"), dest);
  ctx.assign(itemRef, PDFDict.fromMapWithContext(itemFields, ctx));

  const outlinesFields = new Map();
  outlinesFields.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlinesFields.set(PDFName.of("First"), itemRef);
  outlinesFields.set(PDFName.of("Last"), itemRef);
  outlinesFields.set(PDFName.of("Count"), PDFNumber.of(1));
  ctx.assign(outlinesRef, PDFDict.fromMapWithContext(outlinesFields, ctx));

  pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef);

  return await pdfDoc.save({ useObjectStreams: false });
}

// ---- large fixture (procedural, deterministic) -----------------------------

// Tiny seeded PRNG (mulberry32). Same seed -> same byte stream every run.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small, deterministic word bank. We pick words from this with the seeded
// PRNG so body text has roughly book-like character distributions.
const WORD_BANK = [
  "the", "and", "of", "in", "to", "a", "that", "with", "for", "on", "as",
  "was", "were", "by", "an", "be", "she", "he", "they", "them", "his",
  "her", "their", "had", "has", "have", "from", "but", "not", "is", "are",
  "this", "those", "these", "which", "who", "whom", "where", "when", "what",
  "stormy", "valley", "horizon", "lantern", "stone", "river", "winter",
  "morning", "shadow", "letter", "garden", "harbor", "voice", "thread",
  "promise", "compass", "map", "trail", "ember", "candle", "ledger",
  "village", "city", "forest", "mountain", "meadow", "library", "tavern",
  "ship", "captain", "passage", "tower", "dock", "wagon", "wheel", "axle",
  "ash", "willow", "oak", "iron", "copper", "silver", "linen", "wool",
  "cipher", "ledger", "ribbon", "page", "chapter", "footnote", "preface",
  "manuscript", "binding", "stitched", "folded", "creased", "weathered",
];

function pickWord(rng) {
  return WORD_BANK[Math.floor(rng() * WORD_BANK.length)];
}

function buildParagraph(rng, wordCount) {
  const words = [];
  for (let i = 0; i < wordCount; i++) words.push(pickWord(rng));
  if (words.length === 0) return "";
  // Capitalize first word, end with a period.
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ") + ".";
}

// pdf-lib re-encodes/Flate-compresses content streams when saving, so even
// pseudo-random body text ends up at ~3 KB/page on disk. To raise the
// total file size to a realistic targetMB without ballooning the page
// count (which would slow pdf.js extraction), we attach high-entropy
// binary blobs as embedded files via doc.attach(). Random bytes from the
// seeded PRNG don't compress, so the on-disk attachment size ~= the input
// size, and the page count stays bounded regardless of targetMB.
function makeHighEntropyBlob(rng, sizeBytes) {
  const buf = new Uint8Array(sizeBytes);
  // Fill with a deterministic high-entropy stream from the seeded PRNG.
  // We pull 32 random bits per call and unpack 4 bytes from each. The
  // mulberry32 output is uniform enough for 4-byte unpacking to keep the
  // blob effectively incompressible.
  for (let i = 0; i < sizeBytes; i += 4) {
    const r = (rng() * 0x100000000) >>> 0;
    buf[i] = r & 0xff;
    if (i + 1 < sizeBytes) buf[i + 1] = (r >>> 8) & 0xff;
    if (i + 2 < sizeBytes) buf[i + 2] = (r >>> 16) & 0xff;
    if (i + 3 < sizeBytes) buf[i + 3] = (r >>> 24) & 0xff;
  }
  return buf;
}

function chapterTitle(idx) {
  // Stable, well-formed titles. Keep the prefix "Chapter N:" so the TOC
  // regex matches exactly the same shape as the small fixture.
  const themes = [
    "The Arrival", "The Journey", "The Return", "The Letter",
    "The Harbor", "The Cipher", "The Ledger", "The Crossing",
    "The Tower", "The Threshold", "The Compass", "The Promise",
    "The Manuscript", "The Binding", "The Witness", "The Map",
    "The Garden", "The Wagon", "The Ember", "The Folio",
    "The Captain", "The Library", "The Tavern", "The Ribbon",
    "The Stitch", "The Fold", "The Crease", "The Page",
    "The Preface", "The Footnote", "The Margin", "The Index",
  ];
  const theme = themes[(idx - 1) % themes.length];
  return `Chapter ${idx}: ${theme}`;
}

/**
 * Build a deterministic large synthetic PDF.
 *
 * Layout (1-based printed page numbers map to 0-based physical_page_idx):
 *   page 0 (printed 1) — title
 *   page 1 (printed 2) — Contents page with ALL chapter rows in a single
 *     dot-leader column (the TOC detection slides a 30-page window over the
 *     first pages, so we keep the TOC compact on a single page; with 60+
 *     entries this still fits because the y position uses a tight stride).
 *   page 2..N — alternating chapter-start pages and body pages. A chapter
 *     starts every CHAPTER_STRIDE physical pages.
 *
 * The size of the output scales with the body-text density on each body
 * page. We measure once for ~70 KB/page (matches the comment block at the
 * head of this module) and add pages until the in-memory byte count is
 * within +/- 5% of `targetMB * 1024 * 1024`.
 *
 * Returns: { bytes, pageCount, chapterCount, sizeMB }
 */
export async function makeLargeFixturePDF(targetMB = 8) {
  const targetBytes = Math.round(targetMB * 1024 * 1024);
  const rng = mulberry32(0xC0FFEE ^ (targetMB | 0));

  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612;
  const H = 792;

  function newPage() {
    return doc.addPage([W, H]);
  }
  function place(page, y, text, font, size) {
    page.drawText(text, { x: 72, y: H - y, size, font });
  }

  // We aim for a small but real page count (~250 pages total) and meet
  // the targetMB budget by attaching high-entropy random blobs as embedded
  // files (see makeHighEntropyBlob + doc.attach below). This keeps pdf.js
  // extraction fast in the e2e test while still exercising the large-file
  // upload + write code paths with realistic byte counts.
  //
  // Each chapter starts at CHAPTER_STRIDE=30 page intervals. To leave
  // generous headroom over the spec's "at least 5 chapters" floor, we
  // allocate 8 chapter starts: 8*30 + 2 = 242 pages.
  const approxPagesNeeded = 242;
  const CHAPTER_STRIDE = 30; // chapter-start every 30 physical pages
  // Reserve title + TOC at the front; the rest are body/chapter pages.
  const bodyAndChapterPageCount = approxPagesNeeded - 2;
  const chapterCount = Math.max(
    5,
    Math.floor(bodyAndChapterPageCount / CHAPTER_STRIDE),
  );

  // Pre-compute chapter physical page indices and printed labels.
  // Physical: title=0, TOC=1, then chapter k starts at (2 + k*CHAPTER_STRIDE)
  // for k in 0..chapterCount-1. The printed label equals physical_page_idx+1.
  const chapters = [];
  for (let k = 0; k < chapterCount; k++) {
    const physical = 2 + k * CHAPTER_STRIDE;
    chapters.push({
      idx: k + 1,
      title: chapterTitle(k + 1),
      physical_page_idx: physical,
      printed_label: String(physical + 1),
    });
  }

  // ---- page 0: title ------------------------------------------------------
  let p = newPage();
  place(p, 200, "A Walnut Story (Large Edition)", helvB, 28);
  place(p, 240, `Synthetic ${targetMB} MB fixture`, helv, 14);

  // ---- page 1: TOC --------------------------------------------------------
  // Single physical page; rows are tightly stacked. The 30-page TOC scan
  // window in findTOCPages will see this page early (it's page 1).
  p = newPage();
  place(p, 50, "Contents", helvB, 18);
  const leader = ".".repeat(30);
  // Stride down the page in 9-pt rows. With chapterCount up to ~80 we still
  // fit on one page (792 - 50 - margin = ~700 pt; 80 * 9 = 720 — close, so
  // we shrink the row stride if needed).
  const rowStride = chapterCount > 60 ? 8 : 9;
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const yPos = 80 + i * rowStride;
    if (yPos > H - 40) break; // safety
    place(p, yPos, `${ch.title} ${leader} ${ch.printed_label}`, helv, 8);
  }

  // ---- page 2..N: body + chapter starts ----------------------------------
  // We add pages until the saved byte count is at least targetBytes. To
  // avoid re-saving the whole document on every page (which is O(n^2)), we
  // estimate size from a calibration save after a small batch.
  let nextChapter = 0;
  let physical = 2;
  // Always lay down chapter pages at their reserved indices so the TOC
  // entries point at real chapter heads.
  const chapterPageIndices = new Set(chapters.map(c => c.physical_page_idx));

  // Initial batch — at least the first stride so chapter 1 is placed.
  while (physical < approxPagesNeeded) {
    p = newPage();
    if (chapterPageIndices.has(physical) && nextChapter < chapters.length) {
      const ch = chapters[nextChapter++];
      place(p, 100, ch.title, helvB, 18);
      // A short paragraph beneath the heading so the page isn't a single
      // line — keeps body density consistent.
      const lead = buildParagraph(rng, 18);
      place(p, 140, lead, helv, 11);
      // Fill the rest of the page with body text.
      let y = 170;
      while (y < H - 80) {
        const para = buildParagraph(rng, 24 + Math.floor(rng() * 12));
        // Word-wrap at ~80 chars.
        const words = para.split(" ");
        let line = "";
        for (const w of words) {
          if (line.length + w.length + 1 > 80) {
            place(p, y, line, helv, 10);
            y += 14;
            line = w;
            if (y >= H - 80) break;
          } else {
            line = line ? line + " " + w : w;
          }
        }
        if (line && y < H - 80) {
          place(p, y, line, helv, 10);
          y += 18;
        }
      }
    } else {
      // Pure body page. ~20 lines of natural text (compresses well, keeps
      // pdf.js extraction fast). The total file size is met by the binary
      // ballast attached after the page loop — see below.
      let y = 80;
      while (y < H - 80) {
        const para = buildParagraph(rng, 24 + Math.floor(rng() * 12));
        const words = para.split(" ");
        let line = "";
        for (const w of words) {
          if (line.length + w.length + 1 > 80) {
            place(p, y, line, helv, 10);
            y += 14;
            line = w;
            if (y >= H - 80) break;
          } else {
            line = line ? line + " " + w : w;
          }
        }
        if (line && y < H - 80) {
          place(p, y, line, helv, 10);
          y += 18;
        }
      }
    }
    physical++;
  }

  // Calibration save: measure the on-disk byte cost of the page tree
  // before attaching the ballast. We then size the ballast so the final
  // saved file lands within +/- 5% of targetBytes.
  let bytes = await doc.save({ useObjectStreams: false });
  const overheadAfterPages = bytes.byteLength;
  if (overheadAfterPages < targetBytes) {
    // Account for ~3% overhead from the embedded-file dictionary entries
    // wrapping the raw blob. Random bytes don't compress; the wrapper does.
    const ballastBytes = Math.max(0, Math.floor((targetBytes - overheadAfterPages) * 0.985));
    if (ballastBytes > 0) {
      const blob = makeHighEntropyBlob(rng, ballastBytes);
      doc.attach(blob, "walnut-ballast.bin", {
        mimeType: "application/octet-stream",
        description: "synthetic high-entropy ballast for size targeting",
      });
    }
    bytes = await doc.save({ useObjectStreams: false });
  }

  return {
    bytes,
    pageCount: physical,
    chapterCount,
    sizeMB: bytes.byteLength / (1024 * 1024),
    chapters,
  };
}

// ---- real-world PDF fixture ------------------------------------------------
//
// We close the synthetic-fixture gap by validating walnut against a real
// public-domain publication: USGS Circular 1268, "Estimated Use of Water in
// the United States in 2000" (Hutson et al., 2004). This document is:
//   - public domain (US government work, 17 U.S.C. § 105)
//   - hosted on the stable pubs.usgs.gov long-term archive
//   - 52 pages, ~5.8 MB — fast to process, small enough to cache
//   - has a single Contents page (page 5) with proper dot leaders and arabic
//     page numbers, exactly the shape the TOC_LINE_RE regex was designed for
//   - PDF 1.5 with a traditional cross-reference table (NO /Type /XRef
//     streams and NO /Type /ObjStm compressed object streams)
//
// The "no compressed object streams" property is load-bearing: as of
// April 2026 the deployed writeOutlineIncremental walks the page tree by
// regex-scanning the bytes for "<num> <gen> obj" markers, so PDFs that
// hide their /Pages object inside a compressed ObjStm cause the writer to
// throw "no pages found in PDF" and fall back to pdf-lib (which re-emits
// the file from scratch and therefore breaks byte-prefix preservation).
// Modern NIST publications, for example, all use ObjStm; we avoided them
// for that reason. If/when the incremental writer learns to follow refs
// into ObjStm, this test could be retargeted at any modern publication.
//
// The sha256 below is pinned so we can detect a USGS republication that
// would invalidate the test's expectations.
export const REAL_PDF_URL = "https://pubs.usgs.gov/circ/2004/circ1268/pdf/circular1268.pdf";
export const REAL_PDF_SHA256 = "02d02bc67cb0eeef669ddbce0f5e3b328e7cc376af61a3c715ba57d01f963d98";

/**
 * Fetch (and cache) the real-world PDF fixture used by the live-URL e2e test.
 *
 * On first run the bytes are downloaded from REAL_PDF_URL, sha256-verified
 * against REAL_PDF_SHA256, and written to tests/e2e/.cache/<sha>.pdf. On
 * subsequent runs the cache hit returns immediately without hitting the
 * network. The cache directory is gitignored so we don't ship the PDF.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function getRealWorldPDF() {
  const cacheDir = path.join(__dirname, ".cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const hashPath = path.join(cacheDir, REAL_PDF_SHA256 + ".pdf");
  try {
    const cached = await fs.readFile(hashPath);
    return new Uint8Array(cached);
  } catch (_) {
    // fall through to download
  }

  const r = await fetch(REAL_PDF_URL, {
    headers: { "User-Agent": "walnut-test (https://github.com/viktorinkov/pdf-to-chapters)" },
  });
  if (!r.ok) throw new Error(`fixture fetch failed: ${r.status} ${r.statusText}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (got !== REAL_PDF_SHA256) {
    throw new Error(
      `fixture sha256 changed: expected ${REAL_PDF_SHA256}, got ${got}; ` +
      `the upstream PDF at ${REAL_PDF_URL} was republished. ` +
      `If the new bytes are intentional, update REAL_PDF_SHA256 after re-validating ` +
      `that the printed TOC and chapter detection still match the test's expectations.`,
    );
  }
  await fs.writeFile(hashPath, bytes);
  return bytes;
}
