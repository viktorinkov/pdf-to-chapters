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

  return await doc.save();
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

  summarize();
  process.exit(failures === 0 ? 0 : 1);
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
