/**
 * The transcription prompt the spike measures. Mirrors the principles in
 * docs/pdf-web-import.md §4: transcribe, never summarise or translate.
 */

export const TRANSCRIBE_PROMPT = [
  'Transcribe this PDF document into Markdown, faithfully and completely.',
  '',
  'Rules:',
  '- Transcribe. Do not summarise, rephrase, translate or add commentary.',
  '- Keep the document in its original language.',
  '- Restore the heading hierarchy with #, ##, ### … matching the document structure.',
  '- Render tables as GitHub-flavoured Markdown tables.',
  '- Replace figures, diagrams and photographs with a single line: "> [Figure: one-line description]".',
  '- Drop running headers, running footers, page numbers and repeated boilerplate.',
  '- Preserve lists, numbering, code blocks and emphasis.',
  '- Output Markdown only. No preamble, no explanation, no surrounding code fence.',
].join('\n');

/**
 * Variant measured after the first image-only run: with TRANSCRIBE_PROMPT the
 * model classified a full-page scan as a figure and emitted one "> [Figure: …]"
 * line instead of transcribing it. Pages routed as scanned need this extra
 * sentence, otherwise a scanned document converts to nothing.
 */
export const SCAN_PROMPT = `${TRANSCRIBE_PROMPT}
- Some pages are scans: the whole page is one image of a document. Transcribe the text visible in such an image as ordinary Markdown. Only use the "> [Figure: …]" form for a real illustration inside a page, never for a scanned page.`;

/** Continuation hint used for chunked conversion (not exercised in P0). */
export function chunkHint(lastHeadingPath: string[]): string {
  if (!lastHeadingPath.length) return '';
  return `\n\nThis is a continuation. The previous chunk ended under: ${lastHeadingPath.join(' > ')}. Continue the same heading hierarchy; do not repeat earlier content.`;
}
