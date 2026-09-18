/**
 * The no-LLM path: pdfjs lines → plain markdown, deterministically.
 *
 * This is what a manager gets when `IMPORT_PDF_MODE=text` or when the model call
 * fails. It is honestly worse than the LLM output — columns interleave, tables
 * collapse into lines — but it is *predictable*, and predictable beats nothing
 * when the alternative is losing the upload entirely.
 *
 * Everything here is geometry: font height decides headings, vertical gaps
 * decide paragraphs, repetition across pages decides what is page furniture.
 */

import type { PdfInspection, PdfLine } from './inspect';

/** A line this much taller than body text is a subheading… */
const H2_RATIO = 1.35;
/** …and this much taller is a top-level heading. */
const H1_RATIO = 1.7;
/** A vertical gap larger than this many line heights ends a paragraph. */
const PARAGRAPH_GAP_RATIO = 1.5;
/** A line repeated on at least this share of pages is a running header/footer. */
const FURNITURE_PAGE_SHARE = 0.6;
/** Repetition only means anything once there are enough pages to repeat across. */
const FURNITURE_MIN_PAGES = 3;
/** Page furniture is a line, not a sentence; longer repeats are boilerplate content. */
const FURNITURE_MAX_CHARS = 80;
/** Matching modulo digits is only safe on a line short enough to be a header or footer. */
const FURNITURE_MASKED_MAX_CHARS = 40;

// `-` stays last so the character class reads it as a literal, not a range.
const BULLET_GLYPHS = '•·▪▫○●◦‣∙–—*-';
const BULLET_RE = new RegExp(`^[${BULLET_GLYPHS}]\\s+(.*)$`);
const ORDERED_RE = /^(\d{1,3})[.)]\s+(.+)$/;
/** `12`, `- 12 -`, `Page 12`, `12 / 200`. */
const PAGE_NUMBER_RE = /^(?:page\s*)?[-–—(\[]?\s*\d{1,4}\s*(?:(?:\/|of)\s*\d{1,4})?\s*[-–—)\]]?$/i;

interface Block {
  kind: 'heading' | 'paragraph' | 'list';
  level?: 1 | 2;
  text: string;
}

/**
 * Builds markdown from an inspection's line geometry. `title` is the fallback
 * used when the document does not open with something that looks like a title.
 */
export function textFallbackMarkdown(inspection: PdfInspection, title: string): string {
  const isFurniture = pageFurnitureFilter(inspection.pageLines);
  const bodyHeight = dominantHeight(inspection.pageLines, isFurniture);

  const blocks: Block[] = [];
  for (const pageLines of inspection.pageLines) {
    let previous: PdfLine | undefined;
    for (const line of pageLines) {
      if (isFurniture(line.text)) {
        previous = line;
        continue;
      }

      const level = headingLevel(line.height, bodyHeight);
      if (level) {
        blocks.push({ kind: 'heading', level, text: line.text });
        previous = line;
        continue;
      }

      const bullet = line.text.match(BULLET_RE);
      const ordered = line.text.match(ORDERED_RE);
      if (bullet || ordered) {
        blocks.push({
          kind: 'list',
          text: bullet ? `- ${bullet[1].trim()}` : `${ordered?.[1]}. ${ordered?.[2].trim()}`,
        });
        previous = line;
        continue;
      }

      const last = blocks[blocks.length - 1];
      const gap = previous ? previous.y - line.y : Number.POSITIVE_INFINITY;
      const continues =
        last?.kind === 'paragraph' && previous !== undefined && gap <= line.height * PARAGRAPH_GAP_RATIO;
      if (continues && last) {
        last.text = `${last.text} ${line.text}`;
      } else {
        blocks.push({ kind: 'paragraph', text: line.text });
      }
      previous = line;
    }
    // A page break ends the run: there is no shared coordinate space across
    // pages, so any gap we computed there would be meaningless.
  }

  return render(blocks, title);
}

function headingLevel(height: number, bodyHeight: number): 1 | 2 | undefined {
  if (bodyHeight <= 0) return undefined;
  const ratio = height / bodyHeight;
  if (ratio >= H1_RATIO) return 1;
  if (ratio >= H2_RATIO) return 2;
  return undefined;
}

/**
 * Body text is whatever font height carries the most characters — not the most
 * lines, because a page of one-word headings would otherwise win.
 */
function dominantHeight(pageLines: PdfLine[][], isFurniture: (text: string) => boolean): number {
  const weights = new Map<number, number>();
  for (const lines of pageLines) {
    for (const line of lines) {
      if (isFurniture(line.text)) continue;
      const bucket = Math.round(line.height * 2) / 2;
      weights.set(bucket, (weights.get(bucket) ?? 0) + line.text.length);
    }
  }

  let best = 0;
  let bestWeight = -1;
  for (const [height, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && height < best)) {
      best = height;
      bestWeight = weight;
    }
  }
  return best;
}

/** Exact repetition: a running header or watermark is the same line every time. */
function exactKey(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Repetition modulo the numbers in the line, which is what catches "Page 3 of 12"
 * and "ACME Handbook — 7". Only applied to short lines: a numbered *body* line
 * ("Section 3 applies to …") masks to the same key as its neighbours, and
 * mistaking real content for furniture would quietly shrink what fidelity is
 * measured against.
 */
function maskedKey(text: string): string {
  return exactKey(text).replace(/\d+/g, '#');
}

/**
 * Builds a predicate that answers "is this line page furniture?" for one
 * document: a line that recurs on most pages (running header, footer,
 * watermark) or a bare page number.
 *
 * Exported because the fidelity check needs the same answer. The transcription
 * prompt tells the model to drop exactly these lines, so scoring the output
 * against a source that still contains them punishes the model for obeying —
 * the P0 spike measured a perfect transcription at 0.916 for that reason alone.
 */
export function pageFurnitureFilter(pageLines: PdfLine[][]): (text: string) => boolean {
  const { exact, masked } = findFurniture(pageLines);
  return (text: string) => {
    const trimmed = text.trim();
    if (PAGE_NUMBER_RE.test(trimmed)) return true;
    if (exact.has(exactKey(trimmed))) return true;
    return trimmed.length <= FURNITURE_MASKED_MAX_CHARS && masked.has(maskedKey(trimmed));
  };
}

/** Lines that recur on most pages are headers, footers or watermarks, not content. */
function findFurniture(pageLines: PdfLine[][]): { exact: Set<string>; masked: Set<string> } {
  const exact = new Set<string>();
  const masked = new Set<string>();
  if (pageLines.length < FURNITURE_MIN_PAGES) return { exact, masked };

  const exactCounts = new Map<string, number>();
  const maskedCounts = new Map<string, number>();
  for (const lines of pageLines) {
    const short = lines.filter((line) => line.text.length <= FURNITURE_MAX_CHARS);
    for (const key of new Set(short.map((line) => exactKey(line.text)))) {
      exactCounts.set(key, (exactCounts.get(key) ?? 0) + 1);
    }
    const shorter = short.filter((line) => line.text.length <= FURNITURE_MASKED_MAX_CHARS);
    for (const key of new Set(shorter.map((line) => maskedKey(line.text)))) {
      maskedCounts.set(key, (maskedCounts.get(key) ?? 0) + 1);
    }
  }

  const threshold = pageLines.length * FURNITURE_PAGE_SHARE;
  for (const [key, count] of exactCounts) if (key && count >= threshold) exact.add(key);
  for (const [key, count] of maskedCounts) if (key && count >= threshold) masked.add(key);
  return { exact, masked };
}

/**
 * Emits the blocks with exactly one `# ` title at the top: the document's own
 * opening heading when it has one, otherwise the caller's title. Later
 * top-level headings are demoted so the markdown has a single root.
 */
function render(blocks: Block[], title: string): string {
  const out: string[] = [];
  let titleUsed = false;

  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (block.level === 1 && !titleUsed && out.length === 0) {
        out.push(`# ${stripTrailingHashes(block.text)}`);
        titleUsed = true;
        continue;
      }
      if (!titleUsed) {
        out.push(`# ${title}`.trim());
        titleUsed = true;
      }
      // A second top-level heading is demoted: the document keeps one root.
      out.push(`## ${stripTrailingHashes(block.text)}`);
      continue;
    }
    if (!titleUsed) {
      out.push(`# ${title}`.trim());
      titleUsed = true;
    }
    out.push(escapeBlockStart(block.text));
  }

  if (!titleUsed) out.push(`# ${title}`.trim());

  return joinBlocks(out);
}

/**
 * A body line that happens to start with `#` or `>` — a shell comment inside a
 * code listing, say — would otherwise render as a heading or a quote. The source
 * had neither, so escape the marker rather than invent structure.
 */
function escapeBlockStart(text: string): string {
  return text.replace(/^([#>])/, '\\$1');
}

/** ATX headings may be closed with trailing `#`; they are syntax, not text. */
function stripTrailingHashes(text: string): string {
  return text.replace(/\s*#+\s*$/, '').trim() || text.trim();
}

/** List items stay adjacent so they render as one list; everything else is separated. */
function joinBlocks(blocks: string[]): string {
  let markdown = '';
  for (let i = 0; i < blocks.length; i += 1) {
    const current = blocks[i];
    if (i > 0) {
      const previous = blocks[i - 1];
      markdown += isListItem(previous) && isListItem(current) ? '\n' : '\n\n';
    }
    markdown += current;
  }
  return `${markdown}\n`;
}

function isListItem(block: string): boolean {
  return /^(?:- |\d{1,3}\. )/.test(block);
}
