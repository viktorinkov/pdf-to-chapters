// Node-side smoke test for the browser pipeline in site/app.js.
//
// We import the pure-JS chapter-detection logic directly from site/app.js
// and exercise it against a synthetic 12-page PDF that mirrors the fixture
// from scripts/integration_e2e.py::make_test_pdf.
//
// This runs without a browser, without a real Ollama, and without WebLLM.
// pdfjs-dist (legacy build) and pdf-lib are loaded from node_modules; the
// app.js module detects `typeof document === "undefined"` and falls back to
// the npm packages instead of the local browser bundles.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { PDFDocument, StandardFonts, PDFName } from "pdf-lib";

import {
  extractPages,
  findTOCPages,
  parseTOC,
  findHeadings,
  writeOutline,
  writeOutlineIncremental,
  writeOutlinePdfLib,
  MAX_BROWSER_BYTES_DESKTOP,
  MAX_BROWSER_BYTES_MOBILE,
} from "../site/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

let failures = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

function assert(cond, message) {
  if (!cond) throw new Error("assertion failed: " + message);
}

// ---- fixture --------------------------------------------------------------

/**
 * Build a 12-page PDF that mirrors scripts/integration_e2e.py::make_test_pdf.
 *
 * Layout:
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
async function buildFixture() {
  const doc  = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612;
  const H = 792;

  function newPage() {
    return doc.addPage([W, H]);
  }

  // pdf-lib's y origin is bottom-left, but pymupdf in the Python fixture uses
  // a top-down coordinate system. We pick y values that put text in roughly
  // the same visual location; what matters for the heuristics is line order
  // (top-to-bottom) and font size.

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

  // Use legacy xref-table format so the incremental writer can locate the
  // catalog as a top-level indirect object. Real-world books frequently
  // use this format. PDFs with object streams (where the catalog is packed
  // inside an ObjStm) fall through to writeOutlinePdfLib at runtime.
  return await doc.save({ useObjectStreams: false });
}

// ---- helpers --------------------------------------------------------------

function toArrayBuffer(u8) {
  // pdfjs wants an ArrayBuffer; pdf-lib's save() returns a Uint8Array.
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// ---- main -----------------------------------------------------------------

async function main() {
  console.log("walnut browser smoke test");
  console.log("repo: " + path.resolve(__dirname, ".."));
  console.log();

  // 1. fixture
  const u8 = await buildFixture();
  const ab = toArrayBuffer(u8);
  console.log(`[fixture] built ${u8.byteLength}-byte PDF`);

  // 2. extractPages
  let pages;
  try {
    const result = await extractPages(ab);
    pages = result.pages;
    record(
      "extractPages returns 12 pages",
      pages.length === 12,
      `got ${pages.length}`,
    );
  } catch (e) {
    record("extractPages runs", false, e.message);
    summarize();
    process.exit(1);
  }

  // 3. findTOCPages
  const tocPages = findTOCPages(pages);
  record(
    "findTOCPages finds at least one TOC page",
    tocPages.length >= 1,
    `tocPages=${tocPages.length}, entries=${tocPages.map(t => t.entries.length).join(",")}`,
  );

  // 4. parseTOC -> 3 chapters with the right titles
  const chapters = parseTOC(tocPages, pages);
  record(
    "parseTOC returns 3 chapters",
    chapters.length === 3,
    `got ${chapters.length}: ${chapters.map(c => c.title).join(" | ")}`,
  );

  const expectedTitles = [
    "Chapter 1: The Arrival",
    "Chapter 2: The Journey",
    "Chapter 3: The Return",
  ];
  const titlesOk = chapters.length === 3 && expectedTitles.every((t, i) =>
    (chapters[i].title || "").startsWith(t.split(":")[0]) ||
    chapters[i].title === t
  );
  record(
    "chapter titles match expected sequence",
    titlesOk,
    chapters.map(c => c.title).join(" | "),
  );

  // findHeadings should also find something (sanity, fallback path).
  const headings = findHeadings(pages);
  record(
    "findHeadings returns >=1 heading",
    headings.length >= 1,
    `got ${headings.length}`,
  );

  // 5. writeOutline -> bytes with /Outlines in catalog
  if (chapters.length === 0) {
    record("writeOutline runs", false, "no chapters to write");
    summarize();
    process.exit(1);
  }

  let outBytes;
  try {
    outBytes = await writeOutline(u8, chapters);
    record("writeOutline produces non-empty bytes", outBytes && outBytes.byteLength > 0, `${outBytes && outBytes.byteLength} bytes`);
  } catch (e) {
    record("writeOutline runs", false, e.message);
    summarize();
    process.exit(1);
  }

  // 6. Re-load with pdf-lib and inspect /Catalog -> /Outlines
  const reread = await PDFDocument.load(outBytes);
  const catalog = reread.catalog;
  const outlinesRef = catalog.get(PDFName.of("Outlines"));
  record(
    "Catalog has /Outlines entry",
    outlinesRef !== undefined && outlinesRef !== null,
    `outlinesRef=${outlinesRef ? outlinesRef.toString() : "null"}`,
  );

  const outlinesDict = outlinesRef ? reread.context.lookup(outlinesRef) : null;
  const count = outlinesDict ? outlinesDict.get(PDFName.of("Count")) : null;
  const countNum = count && typeof count.asNumber === "function" ? count.asNumber() : null;
  record(
    "/Outlines /Count equals chapter count",
    countNum === chapters.length,
    `Count=${countNum} expected=${chapters.length}`,
  );

  const first = outlinesDict ? outlinesDict.get(PDFName.of("First")) : null;
  const last  = outlinesDict ? outlinesDict.get(PDFName.of("Last"))  : null;
  record(
    "/Outlines has /First and /Last refs",
    first != null && last != null,
    `First=${first ? first.toString() : "null"} Last=${last ? last.toString() : "null"}`,
  );

  // ---- new tests for the incremental writer -------------------------------

  // 7. Byte-equivalent prefix: incremental update is append-only. The first
  //    `original.length` bytes of the output must equal the input exactly.
  let incBytes;
  try {
    incBytes = await writeOutlineIncremental(u8, chapters);
    let prefixOk = incBytes.length >= u8.length;
    if (prefixOk) {
      for (let i = 0; i < u8.length; i++) {
        if (incBytes[i] !== u8[i]) { prefixOk = false; break; }
      }
    }
    record(
      "writeOutlineIncremental produces byte-equivalent prefix",
      prefixOk,
      `inLen=${u8.length} outLen=${incBytes.length}`,
    );
  } catch (e) {
    record("writeOutlineIncremental runs on legacy-xref fixture", false, e.message);
  }

  // 8. Large-file synthesis: a 200-page legacy-format PDF. We're not testing
  //    raw bandwidth (CI memory budgets are tight), just that the code path
  //    handles a much bigger input than the original 12-page fixture and
  //    that the output is still a valid PDF with the right outline.
  let bigBytes, bigOut;
  try {
    bigBytes = await buildBigFixture(200);
    const bigChapters = [];
    for (let i = 0; i < 5; i++) {
      bigChapters.push({
        title: `Chapter ${i + 1}`,
        physical_page_idx: i * 40,
        level: 1,
        printed_label: String(i * 40 + 1),
        confidence: 0.9,
        id: `b${i}`,
      });
    }
    bigOut = await writeOutlineIncremental(bigBytes, bigChapters);
    let prefixOk = bigOut.length >= bigBytes.length;
    if (prefixOk) {
      for (let i = 0; i < bigBytes.length; i++) {
        if (bigOut[i] !== bigBytes[i]) { prefixOk = false; break; }
      }
    }
    record(
      "writeOutlineIncremental handles 200-page fixture (prefix preserved)",
      prefixOk,
      `pages=200 inLen=${bigBytes.length} outLen=${bigOut.length}`,
    );

    const bigReread = await PDFDocument.load(bigOut);
    const bigOutlinesRef = bigReread.catalog.get(PDFName.of("Outlines"));
    const bigOutlines = bigOutlinesRef ? bigReread.context.lookup(bigOutlinesRef) : null;
    const bigCount = bigOutlines ? bigOutlines.get(PDFName.of("Count")) : null;
    const bigCountNum = bigCount && typeof bigCount.asNumber === "function" ? bigCount.asNumber() : null;
    record(
      "200-page fixture: /Outlines /Count equals chapter count",
      bigCountNum === 5,
      `Count=${bigCountNum} expected=5`,
    );
  } catch (e) {
    record("writeOutlineIncremental on 200-page fixture", false, e.message);
  }

  // 9. Nested outlines: a [level 1, level 2, level 1] sequence should produce
  //    a tree with the second item nested under the first, and the third item
  //    a top-level sibling. We assert /First/Last refs and the parent links.
  try {
    const nestedChapters = [
      { id: "n1", title: "Part One",   physical_page_idx: 0, level: 1, printed_label: "1", confidence: 0.9 },
      { id: "n2", title: "Section A", physical_page_idx: 1, level: 2, printed_label: "2", confidence: 0.9 },
      { id: "n3", title: "Part Two",   physical_page_idx: 2, level: 1, printed_label: "3", confidence: 0.9 },
    ];
    const nestedOut = await writeOutlineIncremental(u8, nestedChapters);
    const nestedReread = await PDFDocument.load(nestedOut);
    const outlinesRefN = nestedReread.catalog.get(PDFName.of("Outlines"));
    const outlinesDictN = outlinesRefN ? nestedReread.context.lookup(outlinesRefN) : null;
    const firstN = outlinesDictN.get(PDFName.of("First"));
    const lastN  = outlinesDictN.get(PDFName.of("Last"));
    // Top-level count visible: 1 root + 1 child (visible because expanded)
    // + 1 root = 3 total visible items.
    const countN = outlinesDictN.get(PDFName.of("Count"));
    const countNNum = countN && typeof countN.asNumber === "function" ? countN.asNumber() : null;

    // First item should have /First pointing at "Section A" (its child).
    const firstItem = nestedReread.context.lookup(firstN);
    const firstChildRef = firstItem.get(PDFName.of("First"));
    const firstChild = firstChildRef ? nestedReread.context.lookup(firstChildRef) : null;
    const firstChildTitle = firstChild ? firstChild.get(PDFName.of("Title")) : null;

    // Section A should have /Parent pointing back at Part One.
    const parentRef = firstChild ? firstChild.get(PDFName.of("Parent")) : null;
    const parentMatchesFirst = parentRef && firstN && parentRef.toString() === firstN.toString();

    // Last item should be Part Two and have /Prev pointing at Part One.
    const lastItem = nestedReread.context.lookup(lastN);
    const lastPrev = lastItem.get(PDFName.of("Prev"));
    const lastPrevMatchesFirst = lastPrev && firstN && lastPrev.toString() === firstN.toString();

    record(
      "nested outline: total visible /Count is 3 (2 roots + 1 nested child)",
      countNNum === 3,
      `Count=${countNNum}`,
    );
    record(
      "nested outline: top item has /First child + child links back via /Parent",
      firstChildTitle != null && parentMatchesFirst,
      `firstChildTitle=${firstChildTitle ? "present" : "missing"} parentMatch=${parentMatchesFirst}`,
    );
    record(
      "nested outline: top-level /Prev/Next traversal is correct",
      lastPrevMatchesFirst,
      `lastPrev=${lastPrev ? lastPrev.toString() : "null"} firstN=${firstN ? firstN.toString() : "null"}`,
    );
  } catch (e) {
    record("nested outline writes correctly", false, e.message);
  }

  // 10. File caps reflect the new larger limits.
  record(
    "MAX_BROWSER_BYTES_DESKTOP is 500 MB",
    MAX_BROWSER_BYTES_DESKTOP === 500 * 1024 * 1024,
    `got ${MAX_BROWSER_BYTES_DESKTOP}`,
  );
  record(
    "MAX_BROWSER_BYTES_MOBILE is 150 MB",
    MAX_BROWSER_BYTES_MOBILE === 150 * 1024 * 1024,
    `got ${MAX_BROWSER_BYTES_MOBILE}`,
  );

  summarize();
  process.exit(failures === 0 ? 0 : 1);
}

// ---- big-fixture builder for the incremental writer ----------------------

async function buildBigFixture(pageCount) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const W = 612;
  const H = 792;
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([W, H]);
    p.drawText(`Page ${i + 1} of ${pageCount}`, {
      x: 72, y: H - 100, size: 14, font: helv,
    });
  }
  // Legacy xref so the incremental writer can find the catalog object.
  return await doc.save({ useObjectStreams: false });
}

function summarize() {
  console.log();
  console.log("results");
  console.log("-------");
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${r.name}`);
    if (r.detail) console.log(`         ${r.detail}`);
  }
  console.log();
  if (failures === 0) {
    console.log(`BROWSER SMOKE PASSED  (${results.length}/${results.length})`);
  } else {
    console.log(`BROWSER SMOKE FAILED  (${results.length - failures}/${results.length} ok, ${failures} failed)`);
  }
}

main().catch(e => {
  console.error("uncaught error:", e);
  process.exit(1);
});
