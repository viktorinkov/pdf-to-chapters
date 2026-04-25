# Quality & Evaluation

Trustworthiness is the product. Every metric below ladders up to one number: the rate at which a user opens a `walnut-<name>.pdf` and finds the outline matches what they expected.

## Core principles

- **TOC-first, LLM-second.** Parse a printed Table-of-Contents page when one exists. Fall back to LLM-on-full-text only when TOC parsing fails or looks suspicious. The two pipelines disagreeing is itself a signal.
- **Always preview before write.** A 60-second confirm/edit screen is cheaper than 30 minutes of broken navigation. The preview is non-negotiable.
- **Confidence comes from signals, not from "rate yourself".** Self-reported LLM confidence is poorly calibrated. Use token logprobs, source agreement, and structural verification.
- **Fail loudly, not silently.** A missed chapter is worse than a flagged-for-review chapter.

## Book archetypes (must handle all of these)

| Archetype | Real-world example | Expected outline shape | Tricky bits |
|---|---|---|---|
| **A. Numbered novel** | "The Hobbit" | Flat list: Chapter 1, …, N | Some have prologue/epilogue siblings |
| **B. Titled novel** | "Cloud Atlas" | Flat list of titles, no numbers | Titles may look like body text; rely on font/size |
| **C. Part-divided novel** | "War and Peace" | 2 levels: Part I → Chapter 1..N, Part II → Chapter 1..N | Chapter numbers reset per part |
| **D. Numbered textbook** | "Introduction to Algorithms" | 2–3 levels: Chapter N → Section N.1 → N.1.1; appendices, glossary, index | Decimal numbering is gold; nesting must be respected |
| **E. Reference / handbook** | "Chicago Manual of Style" | Front matter → Numbered parts → Appendices → Glossary → Index | Index entries are NOT outline nodes |
| **F. Memoir / essay collection** | "When Breath Becomes Air" | Flat list of titled chapters + named front/back matter | No numbering; titles are the only signal |
| **G. Multi-author edited volume** | Springer/Wiley handbooks | Flat or 1-deep: Chapter N (Author Name) → Section N.1 | Author names contaminate titles; strip them |
| **H. Non-Latin / RTL** | Chinese 第N章, Arabic فصل, Cyrillic Глава | Flat or 2-level matching the source | Tokenizers, regex, font fallback |

The detector does not ask "what kind of book is this?" upfront. It tries each archetype as a hypothesis and picks the one with the highest agreement signal.

## Confidence scoring

Per-chapter confidence is a weighted fusion of four objective signals (each 0–1):

| Signal | How to compute | Weight |
|---|---|---|
| **Token logprob of title** | Mean `exp(logprob)` of the title tokens emitted by the LLM. Higher = the model committed strongly. | 0.35 |
| **Source agreement** | If both TOC-parse and LLM produced this entry within ±1 page and title sim ≥ 0.85: 1.0; one source only: 0.5; conflict: 0.0 | 0.30 |
| **Heading heuristic match** | Does the detected start page actually contain text of size ≥ p95 of the document, near top of page? Boolean → 1/0 | 0.20 |
| **Self-consistency** | Re-run LLM at temperature=0.3; if both runs produce this entry within ±1 page: 1.0; else 0.5 | 0.15 |

### Thresholds → UX

| Combined score | UI treatment | Default behavior |
|---|---|---|
| ≥ 0.85 | Plain row | Include silently |
| 0.55 – 0.85 | Yellow flag, "low confidence" tooltip | Include, flagged for review |
| < 0.55 | Yellow flag, grouped at top of preview | Include, but if user dismisses preview without reviewing, do NOT silently emit |

We bias toward inclusion because users find it easier to delete a bogus entry than to discover a missed one. The flag is the safety net.

**Why not "rate yourself 1–5"?** Cell Patterns 2025 prompt-engineering survey and the Vellum 2026 confidence-calibration study both showed self-reported LLM confidence is uncorrelated with correctness across providers. Don't bother.

## TOC-vs-LLM reconciliation

```
INPUT: pdf

Stage 1 — Detect TOC pages:
  candidate_pages := first 30 pages where:
    - density of (numeric_token within 5 chars of line end) > 0.3, OR
    - presence of "Contents" / "Table of Contents" / "Inhalt" /
      "Sommaire" / "Índice" / "目次" / "目录" near top
  if candidate_pages:
    toc_entries := parse_toc(candidate_pages)

Stage 2 — Decide pipeline:
  if len(toc_entries) >= 3 and
     toc_entries_match_actual_headings(toc_entries) > 0.7:
    primary := toc_entries
    fallback := None
    confidence_baseline := HIGH
  else:
    primary := llm_pass(constrained_candidate_pages)
    fallback := toc_entries if any else None
    confidence_baseline := MEDIUM

Stage 3 — Reconcile (when both ran):
  for each entry in primary:
    matching := find_in(fallback, page=±1, title_sim=0.85)
    if matching: entry.confidence += AGREEMENT_BONUS
    else:        entry.confidence -= NO_AGREEMENT_PENALTY
  for each entry in fallback NOT in primary:
    add to primary as YELLOW_FLAG with confidence=0.5

Stage 4 — Heuristic post-processing:
  - Snap chapter starts to nearest heading-styled page within ±3
  - Re-nest decimal-numbered entries (3.1 under 3)
  - Drop near-duplicate entries (within 1 page, similar title)
  - Detect index/glossary span and collapse to single "Index" node

Stage 5 — Score every entry's confidence

Stage 6 — Emit preview
```

## Failure modes & corrections

| Mode | Detection signal | Correction strategy |
|---|---|---|
| **A. Hallucinated chapter** | Detected page has no large-font text in top half AND TOC parser did not produce this entry | Drop if confidence < 0.55; otherwise yellow-flag. Show thumbnail in preview so user sees there's no heading. |
| **B. Missed real chapter** | Span between two detected chapters > 2× median chapter length | Re-prompt LLM scoped to the suspect span only ("find the chapter break in pages X–Y"). |
| **C. Off-by-1–3 pages** | Detected page text begins mid-paragraph | Slide window: search ±3 pages for the largest heading-styled text, snap to that page. |
| **D. Two chapters merged** | Detected chapter unusually long (> 2× median) AND a heading-style line in its middle | Heading-heuristic pass on the body; if a candidate fires, split. |
| **E. One chapter split** | Two consecutive entries < 3 pages apart AND second has lowercase or fragmentary title | Merge if title B looks like a continuation. |
| **F. Wrong nesting** | "Chapter 3" and "3.1 Foo" detected as siblings | If title matches `^\d+\.\d+`, force nest under most recent integer-numbered ancestor. |
| **G. Index/glossary entries treated as chapters** | Many entries < 1 page apart in last 10% of document | Detect "index region" by density; emit single "Index" node; suppress sub-entries. |
| **H. Foreign-language headings** | LLM emits English "Chapter" but page text contains "Capítulo" / "Kapitel" / "第N章" | Detect doc language up front (langdetect on first 5 pages); pass language hint into the prompt; localize the regex fallback. Do not translate titles — keep source script. |
| **I. RTL languages** | Arabic / Hebrew documents | Render bookmarks as Unicode (PDF spec supports it); ensure no LTR normalization. |
| **J. Front matter mistaken for chapter 1** | First detected chapter title is "Preface" / "Foreword" but labelled "Chapter 1" by LLM | Maintain a multilingual front-matter token list; relabel as "Front matter" parent. |

## Evaluation metrics

We borrow from the ICDAR Book Structure Extraction competition framework and add hierarchy + tolerance dimensions.

1. **Chapter-start precision / recall / F1** with ±1 page tolerance.
   - A predicted chapter is correct if there exists a GT chapter where `|page_pred − page_gt| ≤ 1`.
   - Report ±0 (strict) and ±3 (relaxed for OCR-heavy) as supplements.
2. **Title fuzzy-match score**: normalized Levenshtein ≥ 0.85 → "title correct".
3. **Hierarchy correctness (TEDS — Tree-Edit-Distance Similarity)**: penalises wrong nesting (a section listed as a sibling of a chapter).
4. **Span coverage**: fraction of pages "covered" by some chapter; missed chapters create gaps.

### Composite

```
walnut_score = 0.4·F1_start(±1) + 0.3·TitleMatch + 0.2·TEDS + 0.1·Coverage
```

Report each component separately so regressions are debuggable.

## Test harness

### Sample set (10 books, fits on a laptop)

| # | Archetype | Sample | Source |
|---|---|---|---|
| 1 | Numbered novel (A) | Pride and Prejudice | Project Gutenberg |
| 2 | Titled novel (B) | The Awakening | Project Gutenberg |
| 3 | Part-divided (C) | War and Peace | Project Gutenberg |
| 4 | Textbook (D) | OpenStax CS title | OpenStax |
| 5 | Textbook (D) | OpenStax math/physics | OpenStax |
| 6 | Reference (E) | Public-domain reference manual | archive.org |
| 7 | Memoir (F) | Untitled-chapter memoir | Project Gutenberg |
| 8 | Edited volume (G) | Springer Open volume | Springer Open |
| 9 | Spanish (H) | Don Quijote | Project Gutenberg (es) |
| 10 | Chinese (H) | 紅樓夢 | wikisource zh |

Hand-label each (15 min/book) into YAML:

```yaml
# fixtures/book-03-war-and-peace.yaml
expected:
  - {title: "Book One",   page: 5,   level: 1}
  - {title: "Chapter I",  page: 7,   level: 2}
  - {title: "Chapter II", page: 14,  level: 2}
```

### Commands

```bash
# Run detector on one book
walnut detect fixtures/book-03-war-and-peace.pdf --json > out.json

# Score against ground truth
walnut eval --pred out.json \
            --gt   fixtures/book-03-war-and-peace.yaml \
            --tolerance 1

# Run the whole suite, produce a dashboard
walnut bench fixtures/ --report report.html
```

### CI gate

Any individual book's `walnut_score` may not drop > 0.05 vs. the main-branch baseline without a reviewer override. Aggregate target: `walnut_score ≥ 0.85`.

### Public datasets for nightly/weekly runs

| Dataset | Size | What it gives | URL |
|---|---|---|---|
| ICDAR-2013 Book Structure Extraction | ~1,000 OCR'd books with labelled TOCs + hierarchy | Headline benchmark; standard for prior tools | https://pageperso.univ-lr.fr/antoine.doucet/StructureExtraction/training/ |
| OmniDocBench (CVPR 2025) | 9 doc types incl. textbooks; layout + section-header + ToC accuracy | Modern; updated through March 2026 | https://github.com/opendatalab/OmniDocBench |
| DocLayNet | 80,863 pages with `Section-header` / `Title` classes | Trains/evaluates the heading-heuristic feeder | https://github.com/DS4SD/DocLayNet |
| Project Gutenberg (PDFs) | 60 K+ public-domain books | Cheap source for archetypes A/B/C/F | https://www.gutenberg.org/help/file_formats.html |
| FinePDFs (HF, 2025) | 475 M PDFs in 1,733 languages | Multilingual sampling | https://www.infoq.com/news/2025/09/finepdfs/ |

## Sources

- https://www.cell.com/patterns/pdf/S2666-3899(25)00108-4.pdf — prompt engineering review (2025)
- https://www.vellum.ai/blog/document-data-extraction-llms-vs-ocrs — LLM confidence calibration (2026)
- https://www.cs.helsinki.fi/u/doucet/papers/ICDAR2011.pdf — ICDAR 2011 paper
- https://hal.science/hal-01073396v1/document — ICDAR 2013 overview
- https://arxiv.org/html/2412.07626v1 — OmniDocBench paper
