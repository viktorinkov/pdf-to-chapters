// Fixture PDF generation for Playwright e2e tests.
//
// Mirrors scripts/test_browser.mjs::buildFixture so the e2e tests exercise
// the same kind of synthetic 12-page book that the Node smoke test uses.

import { PDFDocument, StandardFonts, PDFName, PDFArray, PDFHexString, PDFNumber, PDFDict } from "pdf-lib";

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
