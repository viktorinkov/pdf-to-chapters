// End-to-end tests for the deployed walnut webapp.
//
// We drive a real Chromium against the live URL and run the full
// drop-pdf -> preview -> save flow that a human user would. The fixture is a
// 12-page synthetic book with a printed Table of Contents, mirroring the
// Node smoke test in scripts/test_browser.mjs.
//
// Note (April 2026): the deployed site has a known visual regression — the
// idle screen never gets the .on class on first load, so the dropzone is
// hidden until the App's setState() is called for the first time. The hidden
// <input data-walnut="filepicker"> is still in the DOM and reachable via
// setInputFiles, which is exactly what Playwright does, so the upload-and-
// detect flow still works end-to-end. We assert "filepicker is attached"
// rather than "dropzone is visible" so the regression doesn't mask the
// underlying upload pipeline working. The bug is logged in the report.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { PDFDocument, PDFName } from "pdf-lib";

import { buildFixturePDF, buildBookmarkedFixturePDF, makeLargeFixturePDF, getRealWorldPDF } from "./fixtures.mjs";

const APP_URL = process.env.WALNUT_APP_URL || "https://viktorinkov.github.io/pdf-to-chapters/";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let scratchDir;

test.beforeAll(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "walnut-e2e-"));
});

test.afterAll(async () => {
  if (scratchDir) {
    try { await fs.rm(scratchDir, { recursive: true, force: true }); } catch (_) {}
  }
});

async function writeFixturePDF(name, builder = buildFixturePDF) {
  const bytes = await builder();
  const fp = path.join(scratchDir, name);
  await fs.writeFile(fp, bytes);
  return fp;
}

// We only fail on console.error (severity = error). pdf.js emits a couple of
// font-related warnings (`UnknownErrorException` re standardFontDataUrl) at
// page load that we tolerate.
function attachConsoleWatcher(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push({ text: msg.text(), location: msg.location() });
  });
  page.on("pageerror", (err) => {
    errors.push({ text: String(err && err.message ? err.message : err), location: null });
  });
  return errors;
}

test.describe("walnut e2e", () => {
  test("page loads with all assets", async ({ page }) => {
    const errors = attachConsoleWatcher(page);

    await page.goto(APP_URL);
    await expect(page).toHaveTitle(/walnut/i);

    const dropzone = page.locator('[data-walnut="dropzone"]');
    await expect(dropzone).toBeVisible();

    const filepicker = page.locator('input[data-walnut="filepicker"]');
    await expect(filepicker).toHaveCount(1);

    // The pill starts with "WebGPU: checking..." and the app overwrites it on
    // DOMContentLoaded with either "WebGPU: ready" or "WebGPU: not available".
    const pill = page.locator('[data-walnut="webgpu-pill"]');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/WebGPU: (ready|not available)/, { timeout: 15_000 });

    // Give pdf.js / pdf-lib a beat to lazy-load anything that might warn, then
    // assert no console.error fired during load. (Warnings are fine.)
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(
      errors,
      `console errors observed:\n${errors.map(e => `- ${e.text}`).join("\n")}`,
    ).toHaveLength(0);
  });

  test("uploads a PDF, sees the preview", async ({ page }) => {
    const errors = attachConsoleWatcher(page);
    const fixturePath = await writeFixturePDF("fixture.pdf");

    await page.goto(APP_URL);
    // Wait for the App to wire up the file input (DOMContentLoaded handler).
    await expect(page.locator('input[data-walnut="filepicker"]')).toHaveCount(1);

    // setInputFiles works against the hidden file input directly — this is
    // exactly the path the dropzone's click handler would take. So this
    // exercises the same upload pipeline a real user would hit if they
    // clicked the dropzone, even on the current broken-CSS deployment.
    await page.setInputFiles('input[data-walnut="filepicker"]', fixturePath);

    const previewScreen = page.locator('section[data-screen="preview"]');
    await expect(previewScreen).toHaveClass(/(?:^|\s)on(?:\s|$)/, { timeout: 30_000 });
    await expect(previewScreen).toBeVisible();

    const rows = previewScreen.locator(".chapter-row");
    await expect(rows).toHaveCount(3, { timeout: 10_000 });

    // The chapter list renders <input type="text" class="chapter-title">. We
    // read each via .value and verify they include "Chapter 1/2/3" as substrs.
    const titles = await page
      .locator('[data-walnut="chapter-list"] input.chapter-title')
      .evaluateAll(els => els.map(el => el.value));
    expect(titles).toHaveLength(3);
    expect(titles[0]).toMatch(/Chapter 1/i);
    expect(titles[1]).toMatch(/Chapter 2/i);
    expect(titles[2]).toMatch(/Chapter 3/i);

    const sourceText = await page.locator('[data-walnut="preview-source"]').textContent();
    expect(sourceText, `preview-source was: ${sourceText}`).toMatch(
      /(detected from a printed Table of Contents|detected from page headings)/,
    );

    expect(
      errors,
      `console errors during upload:\n${errors.map(e => `- ${e.text}`).join("\n")}`,
    ).toHaveLength(0);
  });

  test("saves the PDF and downloads it", async ({ page }) => {
    const fixturePath = await writeFixturePDF("fixture-save.pdf");

    await page.goto(APP_URL);
    await expect(page.locator('input[data-walnut="filepicker"]')).toHaveCount(1);
    await page.setInputFiles('input[data-walnut="filepicker"]', fixturePath);

    const previewScreen = page.locator('section[data-screen="preview"]');
    await expect(previewScreen).toHaveClass(/(?:^|\s)on(?:\s|$)/, { timeout: 30_000 });

    const rows = previewScreen.locator(".chapter-row");
    const chapterCount = await rows.count();
    expect(chapterCount).toBeGreaterThanOrEqual(3);

    // Click and wait for download in one expression so we don't race past it.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.locator('[data-walnut="save-btn"]').click(),
    ]);

    const suggested = download.suggestedFilename();
    expect(suggested).toMatch(/^walnut-.*\.pdf$/);

    const savedPath = path.join(scratchDir, "downloaded.pdf");
    await download.saveAs(savedPath);

    const bytes = await fs.readFile(savedPath);
    const reread = await PDFDocument.load(bytes);
    const outlinesRef = reread.catalog.get(PDFName.of("Outlines"));
    expect(outlinesRef, "downloaded PDF must have /Outlines in the catalog").toBeDefined();
    expect(outlinesRef).not.toBeNull();

    const outlinesDict = reread.context.lookup(outlinesRef);
    expect(outlinesDict, "/Outlines must resolve to a dict").not.toBeNull();

    const count = outlinesDict.get(PDFName.of("Count"));
    const countNum = count && typeof count.asNumber === "function" ? count.asNumber() : null;
    expect(countNum).toBe(chapterCount);
  });

  test("rejects a non-PDF file", async ({ page }) => {
    await page.goto(APP_URL);
    await expect(page.locator('input[data-walnut="filepicker"]')).toHaveCount(1);

    const txtPath = path.join(scratchDir, "not-a-pdf.txt");
    await fs.writeFile(txtPath, "this is plain text, not a PDF.");

    await page.setInputFiles('input[data-walnut="filepicker"]', txtPath);

    const errorScreen = page.locator('section[data-screen="error"]');
    await expect(errorScreen).toHaveClass(/(?:^|\s)on(?:\s|$)/, { timeout: 15_000 });
    await expect(errorScreen).toBeVisible();
    await expect(page.locator('[data-walnut="err-text"]')).not.toBeEmpty();
  });

  test("already-bookmarked PDF shows warning before save", async ({ page }) => {
    const bookmarkedPath = await writeFixturePDF(
      "fixture-bookmarked.pdf",
      buildBookmarkedFixturePDF,
    );

    await page.goto(APP_URL);
    await expect(page.locator('input[data-walnut="filepicker"]')).toHaveCount(1);
    await page.setInputFiles('input[data-walnut="filepicker"]', bookmarkedPath);

    const previewScreen = page.locator('section[data-screen="preview"]');
    await expect(previewScreen).toHaveClass(/(?:^|\s)on(?:\s|$)/, { timeout: 30_000 });

    const warning = page.locator('[data-walnut="bookmark-warning"]');
    // The warning is in the DOM unconditionally; the app toggles its
    // visibility via the .on class on the preview screen render.
    await expect(warning).toHaveClass(/(?:^|\s)on(?:\s|$)/);
    await expect(warning).toBeVisible();
  });

  // Mobile viewport scenario. Uses the mobile-chromium project (see
  // playwright.config.mjs). We just assert structural correctness — the OS
  // file picker is platform-specific and not directly tappable in headless.
  test("mobile viewport tappable dropzone @mobile", async ({ page }) => {
    await page.goto(APP_URL);
    const dropzone = page.locator('[data-walnut="dropzone"]');
    await expect(dropzone).toBeVisible();

    const filepicker = page.locator('input[data-walnut="filepicker"]');
    await expect(filepicker).toHaveCount(1);

    // Tapping the (visible or hidden) dropzone calls filepicker.click(),
    // which is a no-op in headless but should not throw. We dispatch a click
    // via JS to exercise the bound handler regardless of CSS state.
    await page.evaluate(() => {
      const el = document.querySelector('[data-walnut="dropzone"]');
      if (el) el.click();
    });
  });

  // Large-file end-to-end. Drives the deployed app with an ~8 MB synthetic
  // PDF (242 pages, 8 chapter starts in a printed TOC) and verifies that:
  //   - the upload pipeline accepts the file (no TOO_LARGE_DESKTOP cap hit)
  //   - chapter detection finds at least 5 chapters from the printed TOC
  //   - clicking save produces a downloaded PDF strictly larger than the
  //     input (the original bytes plus an /Outlines tree at minimum)
  //   - byte-prefix preservation: the first N bytes of the download exactly
  //     match the input (where N = original.length). This is what
  //     writeOutlineIncremental is supposed to guarantee — the new writer
  //     appends an incremental update section instead of re-serialising the
  //     whole document. Until the parallel agent's incremental writer ships
  //     this assertion is expected to FAIL on the live URL (pdf-lib
  //     re-emits the file from scratch). We mark the byte-prefix check as
  //     test.fail() so red here means "the parallel agent's work landed
  //     and now the prefix matches", not "your test broke".
  test("uploads an 8 MB PDF and downloads with bookmarks", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = attachConsoleWatcher(page);

    // 1) Generate the large fixture on disk. This typically takes ~1s.
    const built = await makeLargeFixturePDF(8);
    expect(built.bytes.byteLength).toBeGreaterThanOrEqual(7 * 1024 * 1024);
    expect(built.bytes.byteLength).toBeLessThan(50 * 1024 * 1024);
    expect(built.chapters.length).toBeGreaterThanOrEqual(5);

    const fixturePath = path.join(scratchDir, "fixture-large-8mb.pdf");
    await fs.writeFile(fixturePath, built.bytes);
    const inputBytes = await fs.readFile(fixturePath);
    const inputLen = inputBytes.byteLength;

    // 2) Drive the live URL through the upload flow.
    await page.goto(APP_URL);
    await expect(page.locator('input[data-walnut="filepicker"]')).toHaveCount(1);
    await page.setInputFiles('input[data-walnut="filepicker"]', fixturePath);

    // PDF.js extraction over ~242 pages takes a few seconds on CI VMs;
    // bump the preview-screen wait above the default 30s for safety.
    const previewScreen = page.locator('section[data-screen="preview"]');
    await expect(previewScreen).toHaveClass(/(?:^|\s)on(?:\s|$)/, { timeout: 50_000 });
    await expect(previewScreen).toBeVisible();

    const rows = previewScreen.locator(".chapter-row");
    const chapterCount = await rows.count();
    expect(
      chapterCount,
      `expected >= 5 chapters from a TOC with ${built.chapters.length} entries; got ${chapterCount}`,
    ).toBeGreaterThanOrEqual(5);

    // 3) Trigger save and capture the download.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.locator('[data-walnut="save-btn"]').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^walnut-.*\.pdf$/);
    const savedPath = path.join(scratchDir, "downloaded-large.pdf");
    await download.saveAs(savedPath);

    const outBytes = await fs.readFile(savedPath);
    // Output must be at least as big as the input: new writer appends an
    // outline; old writer re-serialises and may shrink (pdf-lib drops some
    // metadata) — but in either case it should still be in the same order
    // of magnitude. We assert > 7 MB to catch a "the writer truncated the
    // PDF" regression without being too strict on the upper bound.
    expect(
      outBytes.byteLength,
      `output too small: ${outBytes.byteLength}, input was ${inputLen}`,
    ).toBeGreaterThan(7 * 1024 * 1024);

    // The downloaded PDF should still parse and have an /Outlines entry
    // pointing at chapterCount items.
    const reread = await PDFDocument.load(outBytes);
    const outlinesRef = reread.catalog.get(PDFName.of("Outlines"));
    expect(outlinesRef, "downloaded PDF must have /Outlines in catalog").toBeDefined();
    expect(outlinesRef).not.toBeNull();
    const outlinesDict = reread.context.lookup(outlinesRef);
    const count = outlinesDict.get(PDFName.of("Count"));
    const countNum = count && typeof count.asNumber === "function" ? count.asNumber() : null;
    expect(countNum).toBe(chapterCount);

    // 4) Byte-prefix preservation — the load-bearing assertion for the
    // incremental writer. Wrapped in test.step so it shows as a discrete
    // sub-step in the report, and gated on a marker so it can flip from
    // expected-fail to expected-pass cleanly once the parallel agent's
    // writeOutlineIncremental ships to the live URL.
    //
    // To flip: change INCREMENTAL_WRITER_DEPLOYED to true. The CI run that
    // first sees this true will tell us the prefix is preserved end to end.
    const INCREMENTAL_WRITER_DEPLOYED = true;
    const prefixMatches = outBytes.length >= inputLen
      && Buffer.from(outBytes.subarray(0, inputLen)).equals(inputBytes);

    if (INCREMENTAL_WRITER_DEPLOYED) {
      expect(
        prefixMatches,
        "incremental writer is supposed to keep the original bytes as a prefix",
      ).toBe(true);
    } else {
      // Pre-deploy: the old pdf-lib writer rewrites the whole file, so
      // prefix won't match. Don't fail the suite, but log the result so we
      // can see the moment it flips after deploy.
      // eslint-disable-next-line no-console
      console.log(
        `[byte-prefix] inputLen=${inputLen} outLen=${outBytes.byteLength} prefixMatches=${prefixMatches}`,
      );
      test.info().annotations.push({
        type: "byte-prefix-pre-deploy",
        description: `incremental writer not yet deployed; prefixMatches=${prefixMatches}`,
      });
    }

    expect(
      errors.filter(e => !/standardFontDataUrl/i.test(e.text || "")),
      `console errors during large upload:\n${errors.map(e => `- ${e.text}`).join("\n")}`,
    ).toHaveLength(0);
  });

  // Real-world PDF integration test.
  //
  // Every other test in this file uses a synthetic fixture (12-page book or
  // ~8 MB procedurally generated book). That covers the writer + detector on
  // PDFs we control end-to-end, but doesn't tell us whether the pipeline
  // copes with a PDF we did NOT generate — i.e., real publishing tooling,
  // real font subsetting, real cross-reference tables, and a real printed
  // TOC layout that pdf.js extracts in non-trivial ways.
  //
  // We use USGS Circular 1268 "Estimated Use of Water in the United States
  // in 2000". See fixtures.mjs::REAL_PDF_URL for the rationale and
  // properties (public-domain US gov work, 52 pages, ~5.8 MB, traditional
  // xref table so the incremental writer can walk its page tree). Bytes are
  // sha256-pinned + cached under tests/e2e/.cache/ (gitignored) so the
  // first run downloads + validates and every subsequent run hits the
  // cache. If USGS republishes with different bytes the test fails fast on
  // the sha mismatch, which is the right failure mode (we want to know
  // before the test silently starts asserting against new content).
  test("real-world PDF: upload, detect chapters, save, verify outline", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = attachConsoleWatcher(page);

    // 1) Get the real PDF (cache hit on every run after the first).
    const bytes = await getRealWorldPDF();
    const fixturePath = path.join(scratchDir, "real-world.pdf");
    await fs.writeFile(fixturePath, bytes);
    const inputBytes = await fs.readFile(fixturePath);
    const inputLen = inputBytes.byteLength;

    // 2) Drive the live URL through the full upload + detect flow.
    await page.goto(APP_URL);
    await expect(page.locator('input[data-walnut="filepicker"]')).toHaveCount(1);
    await page.setInputFiles('input[data-walnut="filepicker"]', fixturePath);

    // pdf.js text extraction over 52 pages plus chapter detection takes a few
    // seconds; bump the preview-screen wait above the default 30 s for safety.
    const previewScreen = page.locator('section[data-screen="preview"]');
    await expect(previewScreen).toHaveClass(/(?:^|\s)on(?:\s|$)/, { timeout: 60_000 });
    await expect(previewScreen).toBeVisible();

    // 3) The detector should land on the printed TOC and surface chapters.
    const rows = previewScreen.locator(".chapter-row");
    const chapterCount = await rows.count();
    // Any real publication with a printed TOC will produce well over 3
    // entries; USGS Circular 1268 has ~19 entries on its single Contents
    // page. We assert a generous lower bound so trivial regressions in the
    // regex are caught without coupling the test to the exact USGS layout.
    expect(
      chapterCount,
      `expected >= 3 chapters from a real-world TOC; got ${chapterCount}`,
    ).toBeGreaterThanOrEqual(3);

    // 4) The preview should report that the chapters came from a printed
    // TOC (or fall back to page headings if the TOC pass missed). If the
    // detector hits *neither* path the source string would be empty and
    // this assertion catches that regression.
    const sourceText = await page.locator('[data-walnut="preview-source"]').textContent();
    expect(
      sourceText,
      `preview-source was: ${sourceText}`,
    ).toMatch(/(detected from a printed Table of Contents|detected from page headings)/);

    // 5) Trigger save and capture the download.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.locator('[data-walnut="save-btn"]').click(),
    ]);

    // The app prefixes the saved name with "walnut-"; we wrote the input as
    // "real-world.pdf", so we expect "walnut-real-world.pdf".
    expect(download.suggestedFilename()).toMatch(/^walnut-real-world\.pdf$/);
    const savedPath = path.join(scratchDir, "real-world-out.pdf");
    await download.saveAs(savedPath);

    const outBytes = await fs.readFile(savedPath);

    // 6) Output sanity: the incremental writer appends an /Outlines tree to
    // the original bytes, so the output must be at least as big as the
    // input (it's strictly bigger by the size of the appended tree).
    expect(
      outBytes.byteLength,
      `output too small: ${outBytes.byteLength}, input was ${inputLen}`,
    ).toBeGreaterThan(inputLen);

    // 7) Byte-prefix preservation — the load-bearing assertion for the
    // incremental writer. The first inputLen bytes of the output must be
    // exactly the input bytes (the writer appends an incremental update
    // section instead of re-serialising the whole document).
    const prefixMatches = outBytes.length >= inputLen
      && Buffer.from(outBytes.subarray(0, inputLen)).equals(inputBytes);
    expect(
      prefixMatches,
      "incremental writer must preserve the original bytes as a prefix",
    ).toBe(true);

    // 8) Reload the output with pdf-lib and assert the /Outlines tree:
    //    - the catalog references /Outlines
    //    - the outlines root's /Count matches the chapter count we observed
    //      in the preview screen (the writer's Count is total visible
    //      descendants = total nodes when everything is open)
    const reread = await PDFDocument.load(outBytes);
    const outlinesRef = reread.catalog.get(PDFName.of("Outlines"));
    expect(outlinesRef, "downloaded PDF must have /Outlines in catalog").toBeDefined();
    expect(outlinesRef).not.toBeNull();
    const outlinesDict = reread.context.lookup(outlinesRef);
    expect(outlinesDict, "/Outlines must resolve to a dict").not.toBeNull();
    const outlinesCount = outlinesDict.get(PDFName.of("Count"));
    const num = outlinesCount && typeof outlinesCount.asNumber === "function"
      ? outlinesCount.asNumber()
      : null;
    expect(num).toBe(chapterCount);

    // 9) No console errors should fire during the real-world flow. We
    // tolerate the standardFontDataUrl warning that pdf.js emits at load
    // because some PDFs reference standard 14 fonts without embedding them.
    expect(
      errors.filter(e => !/standardFontDataUrl/i.test(e.text || "")),
      `console errors during real-world upload:\n${errors.map(e => `- ${e.text}`).join("\n")}`,
    ).toHaveLength(0);
  });
});
