/**
 * PDF → `ConvertedDocument`.
 *
 * The order is the argument: inspect before spending anything, convert, then
 * measure what came back. Nothing here commits or writes — the result goes into
 * a draft and a human reviews it in the preview, which is what lets this module
 * warn instead of refuse when the conversion is merely *suspect*.
 *
 * See docs/pdf-web-import.md, 결정 4.
 */

import { Logger } from 'services/common/logger';
import type { ConvertedDocument, ImportProgressListener, ImportWarning } from 'services/import/types';
import { ImportRefusal } from 'services/import/types';
import { type PdfImportConfig, loadPdfImportConfig } from './config';
import { fidelityScore } from './fidelity';
import { type PdfInspection, inspectPdf } from './inspect';
import { type PdfLlmClient, convertPdfChunks } from './llm-convert';
import { planPdfImport } from './plan';
import { pageFurnitureFilter, textFallbackMarkdown } from './text-fallback';

export { loadPdfImportConfig, DEFAULT_PDF_IMPORT_CONFIG } from './config';
export type { PdfImportConfig, PdfConversionMode, PdfDetailMode, PdfServiceTier } from './config';
export { inspectPdf } from './inspect';
export type { PdfInspection, PdfLine } from './inspect';
export { planPdfImport, pageRangeLabel, countScannedPages } from './plan';
export type { PdfChunk, PdfImportPlan } from './plan';
export { estimatePdfImport } from './estimate';
export type { PdfImportEstimate } from './estimate';
export { fidelityScore, stripMarkdownSyntax } from './fidelity';
export { textFallbackMarkdown, pageFurnitureFilter } from './text-fallback';
export type { PdfLlmClient } from './llm-convert';

export interface ConvertPdfParams {
  workspaceId: string;
  bytes: Buffer;
  /** Original upload name; used for the title, the commit message and the source note. */
  filename: string;
  onProgress?: ImportProgressListener;
  config?: PdfImportConfig;
  /** Injected in tests; production resolves the workspace's own client. */
  client?: PdfLlmClient;
  model?: string;
}

export async function convertPdf(params: ConvertPdfParams): Promise<ConvertedDocument> {
  const config = params.config ?? loadPdfImportConfig();
  const warnings: ImportWarning[] = [];

  report(params.onProgress, { step: 'checking', label: 'Checking the PDF' });
  const inspection = await inspectPdf(params.bytes, config);
  const plan = planPdfImport(inspection, config);
  const fallbackTitle = inspection.title?.trim() || stripExtension(params.filename);

  let markdown: string;
  let transcribed = false;

  if (inspection.blankPages.length > 0) {
    // Not a warning: `ImportWarningCode` has no word for it, and a handful of
    // divider pages is not something a manager needs to act on.
    Logger.info('PDF import: skipping pages with neither text nor images', {
      operation: 'import.pdf.convert',
      fileName: params.filename,
      blankPages: inspection.blankPages.length,
    });
  }

  if (config.mode === 'text') {
    if (inspection.textPages.length === 0) {
      // Without the LLM there is nothing to read a scanned page with.
      throw new ImportRefusal(422, 'import_pdf_no_text');
    }
    report(params.onProgress, { step: 'converting', label: 'Reading the text layer' });
    markdown = textFallbackMarkdown(inspection, fallbackTitle);
  } else {
    report(params.onProgress, { step: 'converting', label: 'Transcribing the PDF' });
    try {
      const converted = await convertPdfChunks({
        workspaceId: params.workspaceId,
        bytes: params.bytes,
        filename: params.filename,
        inspection,
        plan,
        config,
        onProgress: params.onProgress,
        client: params.client,
        model: params.model,
      });
      markdown = converted.markdown;
      transcribed = true;
    } catch (error) {
      // `llm` mode means the manager asked for the model specifically; failing
      // loudly is the honest answer there. `auto` would rather land something.
      if (config.mode === 'llm') throw error;
      Logger.warn('PDF import: falling back to the text layer after a failed transcription', {
        operation: 'import.pdf.convert',
        fileName: params.filename,
        error: error instanceof Error ? error.message : String(error),
      });
      if (inspection.textPages.length === 0) throw error;
      markdown = textFallbackMarkdown(inspection, fallbackTitle);
      warnings.push({ code: 'low_fidelity', detail: { reason: 'llm_failed' } });
    }
  }

  // Fidelity only means something against text we actually extracted, and only
  // for text the model was supposed to reproduce — a scanned page contributes
  // nothing on either side.
  if (transcribed && inspection.textPages.length > 0) {
    const score = fidelityScore(fidelitySourceText(inspection), markdown);
    if (score < config.fidelityThreshold) {
      warnings.push({ code: 'low_fidelity', detail: { score: Math.round(score * 100) / 100 } });
    }
  }

  if (inspection.scannedPages.length > 0) {
    warnings.push({ code: 'scanned_pages', detail: { count: inspection.scannedPages.length } });
  }

  const title = inspection.title?.trim() || firstHeading(markdown) || stripExtension(params.filename);
  report(params.onProgress, { step: 'ready', label: 'Conversion ready' });

  return {
    markdown: ensureTitleHeading(markdown, title),
    title,
    // PDF images are not extracted as assets; figures become description lines.
    assets: [],
    rejectedAssets: [],
    warnings,
    source: { kind: 'pdf', name: params.filename, pages: inspection.pages },
  };
}

/**
 * The source text a transcription should be scored against: the extracted text
 * of the text pages, minus the running headers, footers and page numbers the
 * prompt told the model to drop. Leaving them in makes a correct transcription
 * of a corporate template look unfaithful, which would cry wolf on exactly the
 * documents this feature exists for.
 */
function fidelitySourceText(inspection: PdfInspection): string {
  const isFurniture = pageFurnitureFilter(inspection.pageLines);
  return inspection.textPages
    .map((page) =>
      inspection.pageLines[page - 1]
        .filter((line) => !isFurniture(line.text))
        .map((line) => line.text)
        .join('\n'),
    )
    .join('\n');
}

/** The first `# ` heading, which is the document's own title when it has one. */
function firstHeading(markdown: string): string | undefined {
  const match = markdown.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * The viewer and the index both expect a document to open with its title, and a
 * chunked transcription can lose it. Cheap to guarantee here, awkward later.
 */
function ensureTitleHeading(markdown: string, title: string): string {
  const body = markdown.trim();
  if (/^#\s+\S/.test(body)) return `${body}\n`;
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '').trim() || filename.trim() || 'Untitled';
}

/** Progress is decoration: a listener that throws must not lose the conversion. */
function report(listener: ImportProgressListener | undefined, event: Parameters<ImportProgressListener>[0]): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // See above.
  }
}
