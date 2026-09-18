import { Logger } from 'services/common/logger';
import type { RemoteImage } from 'services/document/image-captions/fetch-remote-image';
import {
  type ConvertedDocument,
  type ImportProgressEvent,
  type ImportProgressListener,
  ImportRefusal,
  type ImportWarning,
} from 'services/import/types';
import { collectImages, rewriteImageReferences } from './collect-images';
import { fetchPage } from './fetch-page';
import { htmlToMarkdown } from './html-to-markdown';

/**
 * The URL import, end to end: fetch a public page, convert it, and bring its
 * images along.
 *
 * No model is involved (docs/pdf-web-import.md 결정 5). A deterministic result is
 * what fidelity means here — the manager reviews and edits the markdown in the
 * preview before anything is committed, and a conversion that changed its mind
 * between runs would make that review meaningless.
 */

const STEP_LABELS: Record<ImportProgressEvent['step'], string> = {
  checking: 'Checking the URL',
  fetching: 'Fetching the page',
  converting: 'Converting to markdown',
  ready: 'Ready to review',
};

/**
 * Wraps the listener so the import can report freely: progress is decoration on
 * top of work that has already happened, and a listener that throws (a closed
 * NDJSON stream, say) must not take the conversion down with it.
 */
function makeProgressReporter(onProgress?: ImportProgressListener): (step: ImportProgressEvent['step']) => void {
  if (!onProgress) return () => {};

  return (step) => {
    try {
      onProgress({ step, label: STEP_LABELS[step] });
    } catch {
      // See above.
    }
  };
}

export interface ConvertUrlOptions {
  onProgress?: ImportProgressListener;
  /** Injection points for tests; the real implementations are the defaults. */
  fetchPage?: typeof fetchPage;
  fetchImage?: (url: string) => Promise<RemoteImage | null>;
  maxImages?: number;
}

/** True when the document says nothing beyond the heading we put on it. */
function isEmptyDocument(markdown: string): boolean {
  const withoutHeadings = markdown.replace(/^#{1,6} .*$/gm, '');
  return !withoutHeadings.replace(/[\s>\-*_|]/g, '').trim();
}

export async function convertUrl(rawUrl: string, opts: ConvertUrlOptions = {}): Promise<ConvertedDocument> {
  const report = makeProgressReporter(opts.onProgress);
  const fetchPageImpl = opts.fetchPage ?? fetchPage;

  try {
    report('checking');
    report('fetching');
    const page = await fetchPageImpl(rawUrl);

    report('converting');
    const converted = htmlToMarkdown(page.html, page.finalUrl);

    // A page that renders its text with JavaScript arrives here as an empty
    // shell. Refusing is more honest than committing a document with a title and
    // nothing under it; the viewer's message points at saving it as a PDF.
    if (isEmptyDocument(converted.markdown)) {
      throw new ImportRefusal(422, 'import_url_unreadable');
    }

    const { assets, rewrite, rejected } = await collectImages(converted.imageUrls, {
      fetchImage: opts.fetchImage,
      maxImages: opts.maxImages,
    });
    const dropped = new Set(converted.imageUrls.filter((url) => !rewrite.has(url)));
    const markdown = rewriteImageReferences(converted.markdown, rewrite, dropped);

    const warnings: ImportWarning[] = [];
    if (converted.usedFallback) warnings.push({ code: 'readability_fallback' });
    if (rejected.length > 0) warnings.push({ code: 'images_rejected', detail: { count: rejected.length } });

    report('ready');

    return {
      markdown,
      title: converted.title,
      assets,
      rejectedAssets: rejected,
      warnings,
      source: { kind: 'url', name: converted.title, url: page.finalUrl },
    };
  } catch (error) {
    // Refusals are the manager's to act on and travel to the route unchanged;
    // anything else is ours, so it gets logged with the URL that caused it before
    // the route turns it into `import_conversion_failed`.
    if (error instanceof ImportRefusal) throw error;
    Logger.warn('convertUrl: conversion failed', { url: rawUrl, error: (error as Error).message });
    throw error;
  }
}
