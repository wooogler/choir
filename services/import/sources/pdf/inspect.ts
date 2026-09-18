/**
 * The gate: everything we can learn about a PDF without spending a token.
 *
 * pdfjs is deliberately *not* the converter here — the LLM is (see
 * docs/pdf-web-import.md, 결정 4). This pass exists to refuse what we should not
 * accept, to route each page to the right image `detail`, and to give the
 * fidelity check and the text fallback something to work from. Nothing is
 * rendered: no canvas, text and metadata only.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ImportRefusal } from 'services/import/types';
import { type PdfImportConfig, loadPdfImportConfig } from './config';

/** One visual line of a page, as reassembled from pdfjs text items. */
export interface PdfLine {
  text: string;
  /** Font height of the tallest item on the line; the text fallback sizes headings by it. */
  height: number;
  /** PDF user-space y of the baseline. Larger is higher up the page. */
  y: number;
}

export interface PdfInspection {
  pages: number;
  title?: string;
  /** Extracted text per page, index 0 = page 1. */
  pageTexts: string[];
  /** Reassembled lines per page, index 0 = page 1. */
  pageLines: PdfLine[][];
  /** 1-based page numbers with a usable text layer. */
  textPages: number[];
  /** 1-based page numbers with (almost) no text but an embedded image to read it from. */
  scannedPages: number[];
  /** 1-based page numbers carrying at least one embedded raster image. */
  imagePages: number[];
  /** 1-based page numbers with neither usable text nor an image: nothing to transcribe. */
  blankPages: number[];
}

/**
 * Operators that put a raster image on the page. Masks count: a fax-style
 * bilevel scan is an image mask, and it is exactly the case we must not mistake
 * for a blank page. Looked up by name and filtered, so a pdfjs version that
 * drops one of them degrades instead of throwing.
 */
const IMAGE_OP_NAMES = [
  'paintImageXObject',
  'paintImageXObjectRepeat',
  'paintInlineImageXObject',
  'paintInlineImageXObjectGroup',
  'paintImageMaskXObject',
  'paintImageMaskXObjectGroup',
  'paintImageMaskXObjectRepeat',
] as const;

/** Items on the same baseline within this many user-space units belong to one line. */
const LINE_Y_TOLERANCE = 2.5;
/** A horizontal gap wider than this share of the font height reads as a word break. */
const WORD_GAP_RATIO = 0.22;

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * pdfjs hands back `TextItem | TextMarkedContent`; only the former carries text.
 * Marked-content markers have no `str`, so that is the narrowing test.
 */
function toPositionedItem(item: unknown): PositionedItem | undefined {
  const candidate = item as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
  if (typeof candidate.str !== 'string' || !candidate.str.trim()) return undefined;
  const transform = candidate.transform as number[] | undefined;
  if (!Array.isArray(transform) || transform.length < 6) return undefined;
  return {
    text: candidate.str,
    x: transform[4],
    y: transform[5],
    width: typeof candidate.width === 'number' ? candidate.width : 0,
    // Scanned pages sometimes report height 0; fall back to the matrix scale.
    height: typeof candidate.height === 'number' && candidate.height > 0 ? candidate.height : Math.abs(transform[3]),
  };
}

/**
 * Groups text items into lines by baseline and orders each line left to right.
 *
 * PDFs have no notion of a line — only glyph runs at coordinates — and producers
 * emit them in whatever order suits the content stream. Grouping on y is the
 * only thing that survives multi-column layouts and out-of-order runs; the x
 * gap between runs is what tells a word break from a kerning adjustment.
 */
export function buildLines(items: unknown[]): PdfLine[] {
  const positioned = items.map(toPositionedItem).filter((item): item is PositionedItem => item !== undefined);
  if (positioned.length === 0) return [];

  const groups: PositionedItem[][] = [];
  for (const item of [...positioned].sort((a, b) => b.y - a.y)) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].y - item.y) <= LINE_Y_TOLERANCE) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }

  const lines: PdfLine[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.x - b.x);
    let text = '';
    let cursor: number | undefined;
    let height = 0;
    for (const item of group) {
      const gap = cursor === undefined ? 0 : item.x - cursor;
      const needsSpace =
        text.length > 0 && !/\s$/.test(text) && !/^\s/.test(item.text) && gap > item.height * WORD_GAP_RATIO;
      text += (needsSpace ? ' ' : '') + item.text;
      cursor = item.x + item.width;
      height = Math.max(height, item.height);
    }
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed) lines.push({ text: collapsed, height, y: group[0].y });
  }
  return lines;
}

let imageOpCodes: Set<number> | undefined;

/**
 * pdfjs assigns operator codes at load time, so the set is resolved once from
 * the names rather than hard-coded.
 */
function getImageOpCodes(): Set<number> {
  if (!imageOpCodes) {
    const ops = pdfjs.OPS as unknown as Record<string, number | undefined>;
    imageOpCodes = new Set(
      IMAGE_OP_NAMES.map((name) => ops[name]).filter((code): code is number => code !== undefined),
    );
  }
  return imageOpCodes;
}

/**
 * Whether a page draws a raster image at all.
 *
 * This is what separates a scan from a blank page, and the P0 spike showed the
 * distinction is worth money: a page with no text and no image (a vector-only
 * drawing) transcribes to an empty string, so paying for it is paying for
 * nothing. Cheap to ask — the operator list costs less than the text content.
 */
async function pageHasImage(page: { getOperatorList(): Promise<{ fnArray: ArrayLike<number> }> }): Promise<boolean> {
  const codes = getImageOpCodes();
  if (codes.size === 0) return false;
  try {
    const { fnArray } = await page.getOperatorList();
    for (let index = 0; index < fnArray.length; index += 1) {
      if (codes.has(fnArray[index])) return true;
    }
    return false;
  } catch {
    // A page whose operator list will not build is not worth failing the whole
    // import over; treat it as "might carry an image" so it is not called blank.
    return true;
  }
}

function isPasswordException(error: unknown): boolean {
  return error instanceof Error && error.name === 'PasswordException';
}

/**
 * Reads page count, metadata title and per-page text, and refuses anything past
 * the configured limits. Throws `ImportRefusal` for everything a manager can act
 * on; anything else bubbles up as a plain error and becomes a conversion failure.
 */
export async function inspectPdf(
  bytes: Buffer,
  config: PdfImportConfig = loadPdfImportConfig(),
): Promise<PdfInspection> {
  if (bytes.length < 5 || bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new ImportRefusal(415, 'import_unsupported_file');
  }
  if (bytes.length > config.maxBytes) {
    throw new ImportRefusal(413, 'import_too_large', { maxMb: Math.round(config.maxBytes / (1024 * 1024)) });
  }

  // pdfjs takes ownership of the buffer it is handed, so give it a copy: the
  // caller still needs these bytes to slice chunks out of.
  const data = new Uint8Array(bytes);
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    // Nothing is rendered here, so the whole canvas/font-face path is dead
    // weight — and it is the part of pdfjs that needs a DOM.
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
  });

  let doc: Awaited<typeof task.promise> | undefined;
  try {
    try {
      doc = await task.promise;
    } catch (error) {
      if (isPasswordException(error)) throw new ImportRefusal(422, 'import_pdf_encrypted');
      throw error;
    }

    const pages = doc.numPages;
    if (pages > config.maxPages) {
      throw new ImportRefusal(413, 'import_too_many_pages', { pages, max: config.maxPages });
    }

    const title = await readTitle(doc);
    const pageTexts: string[] = [];
    const pageLines: PdfLine[][] = [];
    const textPages: number[] = [];
    const scannedPages: number[] = [];
    const imagePages: number[] = [];
    const blankPages: number[] = [];

    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = buildLines(content.items as unknown[]);
      const text = lines.map((line) => line.text).join('\n');
      pageLines.push(lines);
      pageTexts.push(text);

      const hasText = text.replace(/\s/g, '').length >= config.textPageMinChars;
      const hasImage = await pageHasImage(page);
      if (hasImage) imagePages.push(pageNumber);
      if (hasText) {
        textPages.push(pageNumber);
      } else if (hasImage) {
        scannedPages.push(pageNumber);
      } else {
        blankPages.push(pageNumber);
      }
      page.cleanup();
    }

    if (pages > 0 && blankPages.length === pages) {
      // Every page is a vector drawing or genuinely empty. The spike confirmed
      // the model returns an empty string for these, so refuse rather than bill
      // the workspace for nothing — in every mode, not just `text`.
      throw new ImportRefusal(422, 'import_pdf_no_text');
    }

    return { pages, title, pageTexts, pageLines, textPages, scannedPages, imagePages, blankPages };
  } finally {
    // Destroying the loading task tears down the document and its worker port;
    // leaving it open leaks a worker per import.
    await task.destroy().catch(() => {});
  }
}

async function readTitle(doc: { getMetadata(): Promise<{ info?: unknown }> }): Promise<string | undefined> {
  try {
    const metadata = await doc.getMetadata();
    const info = metadata.info as { Title?: unknown } | undefined;
    const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
    return title || undefined;
  } catch {
    // Metadata is a nicety; a PDF with a broken info dictionary still converts.
    return undefined;
  }
}
