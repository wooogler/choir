# P0 results — PDF · web import spike

Measured 2026-09-18 against `docs/pdf-web-import.md` ("결정 4. PDF 변환", "P0 — 스파이크").
Model for every paid call: **gpt-5.4-mini** (the project default). Token counts come
from `POST /v1/responses/input_tokens`, which is free; everything else is a real
`responses.create`.

**Total spend for the whole spike: $0.056** (7 conversion calls; ~60 free token counts).

## The request shape that works

```ts
await client.responses.create({
  model: 'gpt-5.4-mini',
  input: [{
    role: 'user',
    content: [
      { type: 'input_text', text: TRANSCRIBE_PROMPT },
      // `detail` is accepted on the wire; openai@4.104 types do not know it yet
      { type: 'input_file', filename, file_data: `data:application/pdf;base64,…`, detail: 'low' } as any,
    ],
  }],
  max_output_tokens: 32000,
  reasoning: { effort: 'low' },
  service_tier: 'flex',          // accepted; the response echoes service_tier: 'flex'
});
```

Free token count, same `input`, no SDK helper in 4.104:

```ts
const res = await client.post('/responses/input_tokens', { body: { model, input } });
res.input_tokens; // number
```

## 1. Input tokens — measured, not estimated

Fixed prompt overhead: **140 tokens** per request (the transcription prompt), identical
for `gpt-5.4-mini` and `gpt-5.4`. **Every token count in this spike was byte-identical
between the two models**, so the per-page figures below apply to both; only the price
differs.

`per page` = (total − 140) ÷ pages. Source chars are pdfjs' extracted text.

| sample | pages | detail | input tokens | per page | src chars/page |
| --- | ---: | --- | ---: | ---: | ---: |
| spec (shared-mime-info), whole file | 19 | low | 9,075 | 470 | 1,995 |
| spec, whole file | 19 | high | 20,312 | 1,062 | 1,995 |
| spec, page 1 only | 1 | low | 468 | 328 | 1,443 |
| spec, page 1 only | 1 | high | 473 | 333 | 1,443 |
| table-heavy (generated) | 4 | low | 1,709 | 392 | 1,440 |
| table-heavy (generated) | 4 | high | 1,714 | 394 | 1,440 |
| table-heavy, page 1 | 1 | low | 530 | 390 | 1,436 |
| table-heavy, page 1 | 1 | high | 535 | 395 | 1,436 |
| image-only (3 full-page PNGs, no text layer) | 3 | low | 2,040 | 633 | 0 |
| image-only | 3 | high | 4,631 | 1,497 | 0 |
| image-only, page 1 | 1 | low | 790 | 650 | 0 |
| image-only, page 1 | 1 | high | 1,657 | 1,517 | 0 |
| matplotlib (vector figure, 72×72pt, no text) | 1 | low | 161 | 21 | 0 |
| matplotlib | 1 | high | 166 | 26 | 0 |

### The surprise: `input_file` does not rasterise every page

`detail: low` and no `detail` at all produce **identical** counts — `low` is the default.
And for the text-only samples, `high` costs the same as `low` for most pages but far more
for a few. Slicing the spec page by page (`token-per-page.ts`) shows why:

| page | 4 | 5 | 6 | 7 | 10 | 12 | all other 13 pages |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| high − low | +1,881 | +1,881 | +1,881 | +1,881 | +1,881 | +1,881 | +8 |

Cross-referencing pdfjs operator lists (`page-images.ts`): those six pages, and only those,
have ≥13 `constructPath` operations (vector drawing — the spec's figures and ruled boxes).
Every other page is text-plus-nothing. So:

- **A page that is pure text is never sent as an image, at any `detail`.** Its cost is its
  text: a steady **0.21–0.25 tokens per extracted character** across all 19 pages.
- **A page with real vector graphics is rasterised only at `detail: high`**, costing a flat
  **+1,881 tokens** for a US-Letter page. At `low` it costs nothing extra.
- **An embedded raster image is sent as itself, not as a page render**: the 1052×744 PNG
  pages cost **626–652 tokens at `low`** and **1,493–1,519 at `high`** — not 1,881, i.e. the
  image's own dimensions, not the page's.
- **A vector-only page with no text layer sends almost nothing** (matplotlib: 21–26 tokens
  for the whole file). Confirmed by conversion: the model returned an **empty string**.
  A figure drawn in vectors with no text is invisible to this pipeline.

So the plan's sentence "`input_file`은 PDF에서 텍스트와 페이지 이미지를 둘 다 추출해"
is too strong. Page images appear only for pages that carry graphics, and `detail`
decides whether vector-graphics pages get rendered at all.

### Per-page cost, replacing the plan's estimate table

Measured output is **459–541 tokens per page** (0.21 tok/char of source for prose, 0.38 for
the table sample — GFM pipes inflate it), not the estimated 800.

| per page (gpt-5.4-mini) | plan's estimate `low` | **measured `low`** | plan's estimate `high` | **measured `high`** |
| --- | ---: | ---: | ---: | ---: |
| input, text page | 1,000–1,500 | **470** | 3,000–4,000 | **470** (2,351 if the page has figures) |
| input, scanned page | — | **630–650** | — | **1,500** |
| output | 800 | **460–540** | 800 | **460–540** |
| cost, flex | ≈ $0.004–0.005 | **$0.0013** | ≈ $0.006–0.007 | **$0.0013–0.0020** |
| cost, standard | — | **$0.0026** | — | **$0.0026–0.0040** |
| 40p / 300p, flex | ≈ $0.2 / $1.4 | **$0.05 / $0.39** | ≈ $0.3 / $2 | **$0.05–0.08 / $0.39–0.60** |

The plan over-estimated by **3–4×**. Output tokens are now ~85% of the cost at `low`, so
lowering `detail` saves even less than the plan assumed — but it costs even less to begin with.

## 2. Real conversions

`reasoning: { effort: 'low' }`, `max_output_tokens: 32000`. Fidelity = fraction of the
source's *distinct* character 5-grams (pdfjs text, NFKC + lowercase + whitespace and
punctuation stripped) present in the output markdown. Outputs are in `out/`.

| case | pages | detail | tier | wall | in | out (reasoning) | cost | fidelity | headings | table rows |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `spec-p1-5-low-flex` | 5 | low | flex | 7.9 s | 2,672 | 2,435 (66) | $0.0065 | **0.980** | 8 | 6 |
| `spec-p1-5-high` | 5 | high | default | 12.8 s | 6,422 | 2,478 (84) | $0.0160 | **0.994** | 8 | 6 |
| `spec-full-low-flex` | 19 | low | flex | **55.3 s** | 9,075 | 8,726 (54) | $0.0230 | **0.987** | 29 | 28 |
| `table-low-flex` | 4 | low | flex | 7.3 s | 1,709 | 2,164 (103) | $0.0055 | 0.916 | 13 | 96 |
| `image-high-flex` | 3 | high | flex | 3.2 s | 4,631 | 85 (42) | $0.0019 | n/a | 0 | 0 |
| `image-high-scanprompt` | 3 | high | flex | 3.2 s | 4,684 | 431 (313) | $0.0027 | n/a | 0 | 0 |
| `vector-high-flex` | 1 | high | flex | 1.1 s | 166 | 85 (79) | $0.0003 | n/a | 0 | 0 |

Every call returned `status: "completed"` with `incomplete_details: null`. **Nothing was
truncated, nothing was refused, and nothing came back wrapped in a code fence** — the
"output markdown only, no fence" instruction held in all 7 calls. `cached_tokens` was 0
throughout (no prompt-cache hits at this size).

### What the fidelity numbers mean (`fidelity-detail.ts`)

The score punishes the prompt for obeying itself. Breaking down the missing n-grams:

- `spec-full-low-flex` (0.987) and `spec-p1-5-high` (0.994): **zero missing runs of ≥6
  characters**. The residual is single-character gaps at line-join boundaries — the metric's
  own floor is ≈0.98 even for a perfect transcription.
- `spec-p1-5-low-flex` (0.980): 32 missing characters out of 8,767, in 3 short runs.
- `table-low-flex` (0.916): **all 304 missing characters are the running header
  ("CONFIDENTIAL — Internal Draft"), the page numbers ("Page 1 of 4" …) and the repeated
  caption** — exactly what the prompt was told to drop. Real content fidelity is 1.0.

So the plan's 0.85 warning threshold is safe, but a document with heavy running headers
will drift toward it for the right reasons. Strip repeated per-page headers/footers from
the *source* text before scoring, or the warning will cry wolf on any corporate template.

### Structure quality (judge `out/*.md` by eye)

`spec-full-low-flex` at `detail: low` produced a clean `#`/`##`/`###` hierarchy (29
headings), correct GFM tables, preserved `<?xml …>` code blocks, italics and the RFC-2119
list. `high` on pages 1–5 produced the same 8 headings and the same 6 table rows for
$0.0160 instead of $0.0065 — **no structural gain for text pages**, only the +0.014
fidelity that lives inside the metric's noise floor.

The table sample at `low` reproduced all 8 tables and all 80 rows as GFM (96 pipe rows,
13 headings) with no page image whatsoever.

### Scanned pages: the prompt, not `detail`, is the risk

`image-high-flex` (the plain transcription prompt) read the page and returned **one line**:

```
> [Figure: GnuPG architecture diagram showing GPGME aware applications, GnuPG components, …]
```

Correct by the letter of the prompt — and a total loss of a scanned document. Adding one
sentence ("some pages are scans of a document; transcribe the text visible in them; use the
Figure form only for an illustration inside a page") made the same file come back as
transcribed text (`image-high-scanprompt.md`, reasoning tokens 42 → 313). OCR works; the
prompt has to say which it is. Pages routed as scanned need their own prompt, not just
`detail: high`.

## 3. Web conversion — no LLM

`fetch → JSDOM → Readability(.content) → rehype-parse(fragment) → rehype-remark →
remark-gfm → remark-stringify`, with `script/style/nav/footer/form/noscript` stripped from
the fragment and `a[href]`/`img[src]` absolutised. Outputs in `out/web-*.md`.

| page | title found | Readability | headings (by level) | tables | list items | images | links | rel. links left | junk | chars | convert |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| github.com/mozilla/readability | "GitHub - mozilla/readability: …" | yes (13.6 KB) | 10 (h2×7, h3×3) | 0 | 23 | 0 | 19 | 0 | none of nav/footer/cookie | 7,572 | 3.6 s |
| MDN `<table>` element | "\<table\> HTML table element - HTML \| MDN" | yes (68 KB) | 40 (h2×9, h3×14, h4×17) | 2 | 45 | 1 | 198 | 0 | none | 56,382 | 1.4 s |
| policies.mit.edu 11.2 Privacy of Personal Information | "11.2 Privacy of Personal Information" | yes (8.5 KB) | 7 (h2×7) | 0 | 4 | 0 | 19 | 0 | none | 7,805 | 2.4 s |
| policies.mit.edu 11.0 (section index) | "11.0 Privacy and Disclosure …" | **yes but 231 bytes** | 0 | 0 | 0 | 0 | 0 | 0 | none | **89** | 4.3 s |

Headings, lists, tables, code blocks and images all survive, nav/footer/cookie banners do
not, and no relative URL was left behind on any page. Six real problems:

1. **Readability can "succeed" with nothing.** The MIT section-index page returned 231 bytes
   of HTML → 89 characters of markdown. The plan's fallback only triggers on *empty*
   content. Require a minimum (≈500 text characters) before accepting Readability's answer,
   then fall back to `main`/`article`/`body`.
2. **HTML comments survive rehype-remark.** MDN emits 94 `<!--lit-node 1-->` / `<!--?-->`
   markers straight into the markdown, including inside headings and table cells. Drop
   comment nodes in the hast step.
3. **Anchor links land inside headings.** MDN: `## <!--lit-node 1-->[Try it](#try_it)`;
   MIT: `## [11.2.1 Responsibility for Safeguarding Information]()` (7 empty-href links);
   GitHub: 10 standalone `[](#installation)` lines. Unwrap self-referencing and empty-href
   anchors.
4. **A table cell containing a list breaks the GFM table.** MDN's "Permitted content" row
   spills an ordered list across 12 lines, which ends that table as far as any GFM parser is
   concerned. GFM tables cannot hold block content — either flatten such cells to inline
   text or leave that one table as raw HTML.
5. **Code-block languages are lost.** GitHub's and MDN's syntax-highlighted blocks become
   bare ``` fences. Map the `language-*` / `highlight-source-*` class to the fence info string.
6. **No `#` title in the body.** Readability strips the `<h1>`; the markdown starts at `##`.
   The importer should prepend `# ${article.title}` (it already has the title for
   `suggestedPath`).

Fetches were 75–615 ms; conversion 1.4–4.3 s, dominated by JSDOM parsing a 240–340 KB page.

## 4. pdfjs on Node 22, and heights as a heading signal

`pdfjs-dist/legacy/build/pdf.mjs` under Node 22.14 with no canvas: `numPages`,
`getTextContent`, `getMetadata` and `getOperatorList` all work, **zero console warnings** —
no `DOMMatrix`, no `Path2D`. 19 pages parse in 2.1 s. Encryption detection is via
`PasswordException` on `getDocument(...).promise` (not exercised — no encrypted sample).

Item `height` on the spec (1,321 items with visible text):

| height | 6 | 8 | **9** | **10** | 12 | 14.3 | 17.2 | 24.8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| items | 2 | 36 | **633** | **622** | 1 | 21 | 5 | 1 |

The body is **two** sizes, 9 and 10 (prose vs. the monospaced literals), at 48% / 47% — so
"larger than the mode" already misfires on half the body text. Above that there are three
clean classes: 14.3 (21 = section headings), 17.2 (5 = chapter headings), 24.8 (1 = document
title), i.e. **27 heading candidates in 3 levels**. The LLM produced **29 headings in 4
levels**, correctly nested, plus tables and code blocks that heights say nothing about at
all. On the generated table PDF, pdfjs text collapses every row into one undifferentiated
line — the structure is entirely gone.

Verdict: heights would give a crude 3-level outline for a well-behaved PDF and nothing for
tables. Good enough for `text-fallback.ts`, not good enough to replace the LLM.

## What this means for the plan

- **Default `detail` for text pages: `low`.** Measured: identical heading count, identical
  table output, +0.014 fidelity inside the metric's noise floor, for 2.5× the money and 1.6×
  the wall time. The plan's per-page `auto` routing is still right, but the rule should be
  "`high` only for pages with no usable text layer" — `high` on a text page buys a page
  render the model does not need, and on a *pure* text page buys literally nothing (+8 tokens).
- **The 400k input-token cap is sensible but it will almost never bind.** At 470 tokens per
  text page it is ~850 pages, far past `IMPORT_PDF_MAX_PAGES=200`; for a scan at `high` it is
  ~265 pages, and for a figure-heavy document at `high` ~170. Keep it as the backstop it is,
  but the estimate dialog must also estimate **output** tokens (0.21–0.38 × extracted chars,
  ≈500/page) because output is ~85% of the bill at `low` and no input cap protects it.
- **20-page chunks are right, for time.** One 19-page call completed cleanly in 55 s
  (2.9 s/page) with fidelity 0.987 and no truncation — the plan's worry about a single large
  call was about output limits, and at 8,726 output tokens for 19 pages a 40-page call would
  still fit in a 32k budget. The binding constraint is wall time: 40 pages ≈ 116 s in one
  call, right on the plan's 120 s criterion and past a comfortable proxy timeout. 20-page
  chunks keep each request near 60 s, which is what `proxy_read_timeout` should be sized for.
- **Flex worked, every time.** 6 of 6 flex calls were accepted, `service_tier: "flex"` came
  back in the response, zero 429s, and flex was not visibly slower (7.9 s for 5 pages at flex
  vs. 12.8 s for the same 5 pages at standard — and that call was `high`). Keep flex as the
  default with the standard-tier retry; it halves an already small bill.
- **The LLM's structure beat pdfjs heights, clearly.** 4 heading levels vs. 3 crude size
  classes, plus GFM tables and code blocks that heights cannot see at all, and a body font
  that is two sizes so the naive rule misclassifies half the page. Do not flip decision 5's
  `IMPORT_PDF_MODE=text` to the default.
- **Surprises worth writing into the plan:**
  - No code fence, no refusal, no truncation in any of 7 calls. `stripFence` is still worth
    keeping, but it never fired.
  - `detail: low` == omitting `detail`. There is no third state to worry about.
  - A vector-only page with no text layer converts to an **empty string** — the file is
    effectively invisible. `gate.ts` should reject a document whose pages have neither text
    nor embedded images (`getOperatorList` finds no `paintImageXObject`), with
    `import_pdf_no_text`, rather than charging for a call that returns nothing.
  - The scanned-page prompt gap above: with the plain prompt a scan becomes a one-line
    figure caption. `prompt.ts` needs a scan-aware variant selected by the same per-page
    routing that picks `detail`.
  - Token counts are identical for `gpt-5.4-mini` and `gpt-5.4`, so the estimate can be
    computed once and priced per model.
  - Readability succeeding with 89 characters is a live failure mode; `import_url_unreadable`
    needs a length floor, not an emptiness check.
