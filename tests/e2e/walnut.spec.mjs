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

import { buildFixturePDF, buildBookmarkedFixturePDF } from "./fixtures.mjs";

const APP_URL = "https://viktorinkov.github.io/pdf-to-chapters/";

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
});
