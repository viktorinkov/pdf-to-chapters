# Frontend Design

The website is single-user, runs on `127.0.0.1`, and has five screens (idle / processing / preview / done / error). Two `<script>` tags ship the entire frontend.

## Stack

- **Vanilla HTML** with `<template>` and CSS variables.
- **Alpine.js** (~15 KB) for reactive state.
- **htmx** (~14 KB) for partial swaps when needed (the preview screen mostly).
- **Tailwind standalone CLI** compiled once at build time, OR a single hand-written `style.css`. No npm at runtime.
- **EventSource** native API for SSE; no library.
- All assets self-hosted under `/walnut/web/static/`. No CDN, no Google Fonts call.

## Visual design

Lean into the name. Walnut is wood, books, library. One subtle nod and otherwise stay out of the way — no skeuomorphism, no wood-grain backgrounds.

### Palette

```
--ink:    #2a1f17    /* near-black walnut for text */
--paper:  #f7f3ec    /* warm off-white background */
--shell:  #e8e0d2    /* card / dropzone fill */
--bark:   #6b4a2b    /* primary accent (buttons) */
--sap:    #c8a37a    /* hover/secondary */
--moss:   #5a7a3a    /* success */
--rust:   #9a3b2c    /* error */
--amber:  #b67e1f    /* warning / yellow flag */
```

Dark mode auto-switches via `@media (prefers-color-scheme: dark)`:

```
--ink:    #f0e8db
--paper:  #1a1410
--shell:  #2a201a
--bark:   #c8a37a   /* swap accent + secondary */
--sap:    #6b4a2b
```

### Typography

- **Inter** — UI body. Readable, neutral. System fallback `ui-sans-serif`.
- **Fraunces** — headings + brand mark. Variable serif with optical sizing. Literary, bookish, ties to "walnut" without being precious.
- **JetBrains Mono** — logs, page counters, anything where monospace helps (`page 174 / 312`).

Self-host woff2; do not use Google Fonts (privacy + offline).

### Spacing & layout

- 8 px grid.
- Generous padding: 24/32 px on cards.
- No sidebars. Single column, max-width 720 px, centered.
- Buttons rectangular with 4 px radius (feels printed, not bubbly).
- Hairline borders: 1 px solid `--shell` darkened 8 %.

### Motion

Restrained. Per `axiom-hig` and `motion-design` skills:

- Dropzone scale 1.0 → 1.01 on dragover, 120 ms ease.
- Progress bar uses CSS `transition: width 200ms ease`, not JS animation.
- Single 200 ms fade between screens (`opacity` only, no slides).
- Avoid bouncy easings; this is a tool, not a celebration.

## Wireframes

### Screen 1 — Idle / Upload

```
+---------------------------------------------------------------+
|  walnut                                       . local . v0.1  |
|                                                               |
|         Add bookmarks to a PDF using a local model.           |
|                                                               |
|     +-----------------------------------------------------+   |
|     |                                                     |   |
|     |              drag a PDF here, or click              |   |
|     |              -------------------------              |   |
|     |              up to 200 MB . one file                |   |
|     |                                                     |   |
|     +-----------------------------------------------------+   |
|                                                               |
|   model:  gemma4:e4b (local)              . ollama: ready     |
+---------------------------------------------------------------+
```

Footer status row reads from `/healthz` once on load; toggles to "ollama: not running" if the daemon isn't reachable, with a one-click "show me how" expansion.

### Screen 2 — Processing

```
+---------------------------------------------------------------+
|  walnut                                                       |
|                                                               |
|  the-trial.pdf . 4.6 MB . 312 pages                           |
|                                                               |
|  [###############------------]  56%                           |
|  reading text . page 174 / 312                                |
|                                                               |
|  log:                                                         |
|    > opened pdf, 312 pages                                    |
|    > extracting text . page 174 / 312                         |
|                                                               |
|                                              [ cancel ]       |
+---------------------------------------------------------------+
```

Stage → progress mapping:
- `inspect`: 0 – 5 %
- `extract`: 5 – 60 % (linearly with `page / total`)
- `toc`: 60 – 65 %
- `llm`: 65 – 90 %
- `score`: 90 – 95 %

(`write` happens after preview confirmation — see screen 3.)

### Screen 3 — Preview / Review (the trust screen)

```
+--------------------------------------------------------------------+
|  walnut · Review chapters before saving                            |
|  Source: gravitys-rainbow.pdf · 760 pages · Detected via TOC page  |
+--------------------------------------------------------------------+
|  [ looks good ]   [ re-detect ]   [ + add ]   [ download PDF -> ]  |
+--------------------------------------------------------------------+
|  v Part One: Beyond the Zero                              p. 7   . |
|      Chapter 1                                            p. 9   . |
|      Chapter 2                                            p. 24  . |
|    ! Chapter 3                            (low conf.)     p. 47  . |   <- yellow
|      Chapter 4                                            p. 73  . |
|  v Part Two: Un Perm' au Casino Hermann Goering          p. 187  . |
|      Chapter 1                                           p. 189  . |
|      ...                                                           |
|  v Back matter                                                     |
|      Index                                                p. 749 . |
+--------------------------------------------------------------------+
|  Page preview (click any entry to jump):                           |
|  [thumbnail of detected start page] [ +/- ] adjust page            |
+--------------------------------------------------------------------+
```

Interactions:
- **Inline rename** — click title → editable text field.
- **Page nudge** — ±1, ±5 buttons next to each page number, plus a thumbnail strip showing the detected page and ±2 neighbours.
- **Drag to reparent** — drag a Chapter into a Part to nest it; drag out to flatten.
- **Right-click on row** → Delete, Insert above, Insert below, Promote, Demote.
- **"Re-detect with hints"** — if the user fixed two entries manually, offer to re-run the LLM with their corrections as few-shot examples.
- **Confirm-and-go is one click.** Don't make users think when the result looks right.

Quality signals:
- **Yellow flag** for low-confidence entries (combined < 0.85).
- **Red flag** for impossible entries (out-of-order pages, overlapping spans).
- **Tooltip on every flag** explaining why ("LLM extracted this title, but no heading-sized text was found within 1 page of detected start").
- **Diff view** between TOC-parse and LLM passes when both ran; user picks winner with one click.

Skip option: power users / automation can set "skip preview" via URL param `?skip_preview=1` or settings toggle. Default = preview ON.

### Screen 4 — Complete

```
+---------------------------------------------------------------+
|  walnut                                                       |
|                                                               |
|  done . 14 chapters detected                                  |
|                                                               |
|    1.  The Arrest                              p.   3         |
|    2.  Conversation with Frau Grubach          p.  21         |
|    3.  In the Empty Courtroom                  p.  39         |
|    ...                                                        |
|                                                               |
|       [ download walnut-the-trial.pdf ]   [ do another ]      |
+---------------------------------------------------------------+
```

Auto-trigger the download after a 500 ms delay (or on click). After download, the file lives in the user's Downloads folder; the temp file on the server is cleaned 1 hour later.

### Screen 5 — Error

```
+---------------------------------------------------------------+
|  walnut                                                       |
|                                                               |
|   could not bookmark this pdf                                 |
|                                                               |
|   reason: the file is password-protected.                     |
|   walnut does not unlock encrypted pdfs.                      |
|                                                               |
|       [ try another file ]                                    |
+---------------------------------------------------------------+
```

Specific error states:
- `ENCRYPTED` — "the file is password-protected. walnut does not unlock encrypted pdfs."
- `TOO_LARGE` — "this file is over 200 MB. try splitting it first."
- `OLLAMA_DOWN` — "I can't reach Ollama on localhost:11434. is it running? `brew services start ollama`."
- `MODEL_MISSING` — "Ollama is up, but `gemma4:e4b` isn't pulled. run `ollama pull gemma4:e4b`."
- `NO_TEXT` — "this looks like a scanned PDF (no text layer). run `ocrmypdf input.pdf input_ocr.pdf` first."
- `NO_CHAPTERS` — "the model didn't find any chapters. [save anyway with no bookmarks] [retry with a larger model]"
- `INVALID_PDF` — "this file is corrupted past repair. sorry."

## Brand mark

Lowercase `walnut` in Fraunces. The dot of the lowercase i in `walnut`'s glyph stack — there is no `i` — so instead use a tiny circular nut glyph as the favicon and skip the wordmark adornment. Wordmark only is fine.

## Accessibility

- All interactive elements `:focus-visible` ring in `--bark`.
- ARIA live region for stage updates: `<div role="status" aria-live="polite">`.
- Dropzone uses native `<input type="file">` so keyboard / screen reader work without overrides.
- Color is never the only signal; flags include text label ("low confidence") and an icon.
- Respect `prefers-reduced-motion`: zero out the screen-fade and dropzone scale.
- Test with VoiceOver on macOS.

## Frontend skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>walnut</title>
  <link rel="stylesheet" href="/static/style.css">
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
  <script defer src="/static/alpine.min.js"></script>
</head>
<body x-data="walnut()">
  <header><h1 class="brand">walnut</h1></header>

  <main>
    <!-- Screen 1: idle -->
    <section x-show="screen==='idle'" class="card dropzone"
             @dragover.prevent="hover=true"
             @dragleave="hover=false"
             @drop.prevent="onDrop($event)"
             :class="{hover}">
      <p>drag a PDF here, or <button @click="$refs.fp.click()">browse</button></p>
      <input x-ref="fp" type="file" accept="application/pdf" hidden
             @change="onPick($event)">
    </section>

    <!-- Screen 2: run -->
    <section x-show="screen==='run'" class="card">
      <h2 x-text="job.filename"></h2>
      <div class="bar"><div class="fill" :style="`width:${pct}%`"></div></div>
      <p class="mono" x-text="status"></p>
      <button @click="cancel()">cancel</button>
    </section>

    <!-- Screen 3: preview - rendered by an HTMX swap or Alpine x-for over chapters -->
    <section x-show="screen==='preview'" class="card preview"></section>

    <!-- Screen 4: done -->
    <section x-show="screen==='done'" class="card">
      <h2>done . <span x-text="chapters"></span> chapters</h2>
      <a class="btn" :href="`/jobs/${job.id}/download`"
         x-text="'download walnut-' + job.filename"></a>
      <button @click="reset()">do another</button>
    </section>

    <!-- Screen 5: err -->
    <section x-show="screen==='err'" class="card error">
      <h2>could not bookmark this pdf</h2>
      <p x-text="errMsg"></p>
      <button @click="reset()">try another</button>
    </section>
  </main>

  <script src="/static/walnut.js"></script>
</body>
</html>
```

The `walnut()` Alpine component holds: `screen`, `job`, `pct`, `status`, `chapters`, `errMsg`, an `EventSource` reference, and methods `upload`, `listen`, `confirm`, `cancel`, `reset`, `fail`.

## Why no SPA framework

Four screens. One EventSource. Two forms. SvelteKit / React / Solid would add a build step, a node_modules directory, and ~50 KB of framework just to render this. Alpine.js + htmx ships ~30 KB and zero build infrastructure.
