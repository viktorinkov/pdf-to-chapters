// Run extractPages + findTOCPages + parseTOC + findHeadings on a real PDF
// and dump what each stage produced. Use to iterate on detector quality.
//
// usage:
//   node scripts/diagnose.mjs /path/to/book.pdf [--page N] [--lines N]

import fs from "node:fs/promises";
import path from "node:path";
import {
  extractPages, findTOCPages, parseTOC, findHeadings,
} from "../site/app.js";

const args = process.argv.slice(2);
const pdfPath = args.find(a => !a.startsWith("--"));
if (!pdfPath) {
  console.error("usage: node scripts/diagnose.mjs <path-to-pdf> [--sample-page N]");
  process.exit(1);
}

const bytes = await fs.readFile(pdfPath);
console.log(`loaded ${bytes.length.toLocaleString()} bytes from ${path.basename(pdfPath)}`);

const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const { pages } = await extractPages(ab);
console.log(`extracted ${pages.length} pages`);

console.log("\n=== TOC detection ===");
const tocPages = findTOCPages(pages);
console.log(`tocPages.length = ${tocPages.length}`);
for (const tp of tocPages.slice(0, 3)) {
  console.log(`  page ${tp.page_idx}: ${tp.entries.length} entries`);
  for (const e of tp.entries.slice(0, 8)) console.log(`    ${JSON.stringify(e)}`);
  if (tp.entries.length > 8) console.log(`    ... (${tp.entries.length - 8} more)`);
}

console.log("\n=== parseTOC ===");
const tocChapters = parseTOC(tocPages, pages);
console.log(`parseTOC -> ${tocChapters.length} chapters`);
for (const c of tocChapters.slice(0, 30)) {
  console.log(`  L${c.level} ${String(c.printed_label).padStart(5)} -> p${c.physical_page_idx + 1} | ${c.title.slice(0, 80)}`);
}
if (tocChapters.length > 30) console.log(`  ... (${tocChapters.length - 30} more)`);

console.log("\n=== heading heuristic fallback (always shown for diagnostics) ===");
const headings = findHeadings(pages);
console.log(`findHeadings -> ${headings.length} candidates`);
for (const c of headings.slice(0, 20)) {
  console.log(`  ${String(c.printed_label).padStart(5)} -> p${c.physical_page_idx + 1} | ${c.title.slice(0, 80)}`);
}

const sampleArg = args.indexOf("--sample-page");
const sampleIndices = sampleArg >= 0
  ? [parseInt(args[sampleArg + 1], 10) - 1]
  : [0, 5, Math.min(10, pages.length - 1), Math.min(15, pages.length - 1), Math.min(25, pages.length - 1)];

console.log(`\n=== sample pages ${sampleIndices.map(i => i + 1).join(", ")} ===`);
for (const idx of sampleIndices) {
  if (idx < 0 || idx >= pages.length) continue;
  const p = pages[idx];
  const maxFs = p.lines.length ? Math.max(...p.lines.map(l => l.font_size)) : 0;
  console.log(`\n--- physical page ${idx + 1} (${p.lines.length} lines, max font ${maxFs.toFixed(1)}pt) ---`);
  for (const l of p.lines.slice(0, 14)) {
    console.log(`  [${l.font_size.toFixed(1)}pt @ x=${(l.x | 0)} y=${(l.y | 0)}] ${JSON.stringify(l.text.slice(0, 100))}`);
  }
}
