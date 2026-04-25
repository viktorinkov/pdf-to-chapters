// Benchmark the walnut pipeline on a synthetic 50 MB PDF.
//
// This is NOT part of the CI test suite — it's a one-shot harness for
// confirming the memory and time profile of the new incremental outline
// writer (writeOutlineIncremental, currently in flight in site/app.js).
// Run with:
//
//     node scripts/bench_large.mjs
//
// The script generates a deterministic 50 MB PDF in memory (via
// makeLargeFixturePDF), then times each stage of the pipeline (extractPages,
// findTOCPages + parseTOC, writeOutlineIncremental if available else
// writeOutline) while sampling process.memoryUsage() before/after.
//
// We intentionally do NOT ship a 50 MB binary fixture in the repo; the
// fixture is regenerated at runtime in ~3-5 seconds.
//
// Memory assertion: writeOutlineIncremental must NOT pull more than 4x the
// input file size into the heap. This catches a regression to a full-doc
// parser (which would balloon to ~3-6x for pdf-lib on larger files).

import { performance } from "node:perf_hooks";

import { makeLargeFixturePDF } from "../tests/e2e/fixtures.mjs";
import * as appModule from "../site/app.js";

const TARGET_MB = Number(process.env.WALNUT_BENCH_MB || 50);
const HEAP_BLOWUP_FACTOR = 4; // assertion ceiling for incremental writer

function fmtBytes(n) {
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  const kb = n / 1024;
  return `${kb.toFixed(1)} KB`;
}

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(0)} ms`;
}

function snapshotHeap(label) {
  // Force a GC if the runtime exposes it (node --expose-gc). Otherwise we
  // just sample what V8 reports. Either way, we report heapUsed deltas, so
  // jitter from minor allocations between samples washes out.
  if (typeof globalThis.gc === "function") {
    try { globalThis.gc(); } catch (_) {}
  }
  const m = process.memoryUsage();
  return { label, ...m };
}

async function timed(label, fn) {
  const before = snapshotHeap(`${label}.before`);
  const t0 = performance.now();
  let result, err;
  try {
    result = await fn();
  } catch (e) {
    err = e;
  }
  const t1 = performance.now();
  const after = snapshotHeap(`${label}.after`);
  const dt = t1 - t0;
  const dHeap = after.heapUsed - before.heapUsed;
  const peakLikely = Math.max(before.heapUsed, after.heapUsed);
  return { label, ms: dt, before, after, dHeap, peakLikely, result, err };
}

function printStage(stage) {
  console.log(`  [${stage.label}]`);
  console.log(`    time:        ${fmtMs(stage.ms)}`);
  console.log(`    heap before: ${fmtBytes(stage.before.heapUsed)}`);
  console.log(`    heap after:  ${fmtBytes(stage.after.heapUsed)}`);
  console.log(`    heap delta:  ${fmtBytes(stage.dHeap)} (${stage.dHeap >= 0 ? "+" : ""}${stage.dHeap})`);
  if (stage.err) {
    console.log(`    ERROR: ${stage.err.message || stage.err}`);
  }
}

function pickWriter(mod) {
  // Prefer the incremental writer if the parallel agent has landed it.
  if (typeof mod.writeOutlineIncremental === "function") {
    return { fn: mod.writeOutlineIncremental, name: "writeOutlineIncremental" };
  }
  return { fn: mod.writeOutline, name: "writeOutline (legacy pdf-lib)" };
}

async function main() {
  console.log("walnut large-file benchmark");
  console.log(`  target size: ${TARGET_MB} MB`);
  console.log(`  node:        ${process.version}`);
  console.log(`  --expose-gc: ${typeof globalThis.gc === "function" ? "yes" : "no (heap deltas may be noisier)"}`);
  console.log();

  // 1. Build the fixture.
  console.log("[1/4] building synthetic fixture…");
  const buildStage = await timed("build_fixture", async () => {
    return await makeLargeFixturePDF(TARGET_MB);
  });
  if (buildStage.err) {
    console.error("fixture build failed:", buildStage.err);
    process.exit(2);
  }
  const built = buildStage.result;
  console.log(`  built ${built.pageCount} pages, ${fmtBytes(built.bytes.byteLength)} (target ${TARGET_MB} MB)`);
  console.log(`  TOC chapters planned: ${built.chapterCount}`);
  printStage(buildStage);
  console.log();

  // 2. extractPages.
  console.log("[2/4] extractPages…");
  const ab = built.bytes.buffer.slice(
    built.bytes.byteOffset,
    built.bytes.byteOffset + built.bytes.byteLength,
  );
  const extractStage = await timed("extractPages", async () => {
    return await appModule.extractPages(ab);
  });
  if (extractStage.err) {
    console.error("extractPages failed:", extractStage.err);
    process.exit(2);
  }
  const pages = extractStage.result.pages;
  console.log(`  pages extracted: ${pages.length}`);
  printStage(extractStage);
  console.log();

  // 3. findTOCPages + parseTOC.
  console.log("[3/4] findTOCPages + parseTOC…");
  const tocStage = await timed("toc_detect", async () => {
    const tocPages = appModule.findTOCPages(pages);
    const chapters = appModule.parseTOC(tocPages, pages);
    return { tocPages, chapters };
  });
  const { tocPages, chapters } = tocStage.result;
  console.log(`  toc pages: ${tocPages.length}`);
  console.log(`  parsed chapters: ${chapters.length}`);
  printStage(tocStage);
  console.log();

  if (chapters.length === 0) {
    console.error("no chapters parsed from synthetic TOC; aborting writer benchmark");
    process.exit(2);
  }

  // 4. write outline.
  const writer = pickWriter(appModule);
  console.log(`[4/4] ${writer.name}…`);
  const writeStage = await timed("write_outline", async () => {
    return await writer.fn(built.bytes, chapters);
  });
  if (writeStage.err) {
    console.error("writer failed:", writeStage.err);
    process.exit(2);
  }
  const outBytes = writeStage.result;
  console.log(`  output: ${fmtBytes(outBytes.byteLength)}`);
  printStage(writeStage);
  console.log();

  // ---- summary ------------------------------------------------------------
  console.log("summary");
  console.log("-------");
  console.log(`  input file:        ${fmtBytes(built.bytes.byteLength)} (${built.pageCount} pages)`);
  console.log(`  output file:       ${fmtBytes(outBytes.byteLength)}`);
  console.log(`  delta (out - in):  ${fmtBytes(outBytes.byteLength - built.bytes.byteLength)}`);
  console.log(`  extract time:      ${fmtMs(extractStage.ms)}`);
  console.log(`  toc detect time:   ${fmtMs(tocStage.ms)}`);
  console.log(`  write time:        ${fmtMs(writeStage.ms)} (${writer.name})`);
  console.log();

  // ---- memory assertion --------------------------------------------------
  // For the incremental writer specifically, the heap delta during
  // write_outline must be < HEAP_BLOWUP_FACTOR * input_size. The legacy
  // pdf-lib writer is exempt — we don't fail on it; we just print a
  // warning, since exposing this regression is what motivates the
  // incremental rewrite in the first place.
  const inputSize = built.bytes.byteLength;
  const writeHeapDelta = Math.max(0, writeStage.dHeap);
  const ratio = writeHeapDelta / Math.max(1, inputSize);
  const isIncremental = writer.name === "writeOutlineIncremental";

  console.log(`  write heap delta:  ${fmtBytes(writeHeapDelta)} (${ratio.toFixed(2)}x input)`);
  if (isIncremental) {
    if (ratio > HEAP_BLOWUP_FACTOR) {
      console.error(
        `\nFAIL: incremental writer used ${ratio.toFixed(2)}x input in heap; ` +
          `expected <= ${HEAP_BLOWUP_FACTOR}x. ` +
          `Did the writer fall back to a full-doc parse?`,
      );
      process.exit(1);
    } else {
      console.log(
        `  PASS: incremental writer stayed under the ${HEAP_BLOWUP_FACTOR}x heap ceiling.`,
      );
    }
  } else {
    console.log(
      `  (legacy writer; no memory ceiling enforced. ` +
        `The ${HEAP_BLOWUP_FACTOR}x ceiling kicks in once writeOutlineIncremental is exported.)`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("uncaught:", e);
  process.exit(1);
});
