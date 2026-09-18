/**
 * Turns an inspection into the sequence of requests we will actually send.
 *
 * Two independent pressures shape a chunk. Output length: no model transcribes
 * 300 pages in one response, so ranges have to be small enough to finish. Cost:
 * a page image at `detail: 'high'` costs several times one at `'low'`, and only
 * scanned pages need it — a page whose text layer already came through in the
 * `input_file` just needs the image as a structure hint.
 *
 * Both are served by cutting at the text/scanned boundary first and only then by
 * length, so one scanned page in the middle of a report cannot drag the pages
 * around it up to `high`.
 *
 * A blank page (no text, no image) counts as neither: it is not in
 * `scannedPages`, so it rides along with the text pages and never upgrades a
 * chunk — there is nothing on it for a page render to show.
 */

import type { PdfImportConfig } from './config';
import type { PdfInspection } from './inspect';

export type PdfChunkDetail = 'low' | 'high';

export interface PdfChunk {
  /** 1-based, inclusive. */
  from: number;
  /** 1-based, inclusive. */
  to: number;
  detail: PdfChunkDetail;
}

export interface PdfImportPlan {
  chunks: PdfChunk[];
  /** Carried through so the estimate and the warnings do not re-derive it. */
  scannedPages: number[];
}

/**
 * How many of a chunk's pages are scans. The conversion and the pre-flight
 * estimate must agree on this, because it changes the prompt and therefore the
 * token count.
 */
export function countScannedPages(chunk: { from: number; to: number }, scannedPages: number[]): number {
  return scannedPages.filter((page) => page >= chunk.from && page <= chunk.to).length;
}

/** A short human label for a chunk, for progress lines and logs. */
export function pageRangeLabel(chunk: { from: number; to: number }): string {
  return chunk.from === chunk.to ? `p. ${chunk.from}` : `pp. ${chunk.from}–${chunk.to}`;
}

export function planPdfImport(inspection: PdfInspection, config: PdfImportConfig): PdfImportPlan {
  const scanned = new Set(inspection.scannedPages);
  const chunkPages = Math.max(1, config.chunkPages);
  const chunks: PdfChunk[] = [];

  let runStart = 1;
  for (let page = 1; page <= inspection.pages; page += 1) {
    const isLast = page === inspection.pages;
    const boundary = isLast || scanned.has(page) !== scanned.has(page + 1);
    if (!boundary) continue;

    // One run of same-kind pages, split by length only.
    const detail = detailFor(scanned.has(page), config);
    for (let from = runStart; from <= page; from += chunkPages) {
      chunks.push({ from, to: Math.min(from + chunkPages - 1, page), detail });
    }
    runStart = page + 1;
  }

  return { chunks, scannedPages: inspection.scannedPages };
}

function detailFor(runIsScanned: boolean, config: PdfImportConfig): PdfChunkDetail {
  if (config.detail === 'low' || config.detail === 'high') return config.detail;
  return runIsScanned ? 'high' : 'low';
}
