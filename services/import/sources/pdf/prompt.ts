/**
 * The transcription prompt.
 *
 * The one rule this whole feature rests on: the model transcribes, it does not
 * write. A summary that reads well is worse than a rough transcription, because
 * the manager reviewing the preview has no way to see what was quietly dropped —
 * and the fidelity check can only measure text that was meant to survive.
 *
 * See docs/pdf-web-import.md, 결정 4 ("프롬프트 원칙은 전사").
 */

export interface TranscriptionPromptParams {
  /** Original upload name, used only as a title hint. */
  filename: string;
  /** PDF metadata title, when it has one. */
  title?: string;
  /** Label for the pages in this chunk, e.g. `pp. 21–40`. */
  pageRange: string;
  /** The first chunk owns the document's `# ` title; later chunks must not repeat it. */
  isFirstChunk: boolean;
  /** Heading stack open at the end of the previous chunk, outermost first. */
  previousHeadingPath?: string[];
  /**
   * How many pages in this chunk have no text layer. Above zero the prompt gains
   * the scan instruction; the P0 spike showed the plain prompt turns a scanned
   * document into a single `> [Figure: …]` line, which is correct by the letter
   * of the rules and a total loss of the document.
   */
  scannedPages?: number;
}

export const SCAN_INSTRUCTION =
  'Some or all of these pages are scans: the page image IS the document, photographed or scanned, not an illustration. Read the text in those page images and transcribe it in full, with the same heading, table and list rules as everywhere else. Use the `> [Figure: …]` form only for an actual picture, chart or diagram sitting inside a page — never for a page that is itself a scan of text.';

export const TRANSCRIPTION_RULES = [
  'You are transcribing a PDF into markdown for a documentation repository. Transcribe — do not summarize, do not paraphrase, do not translate, do not add commentary of your own.',
  "Write in the document's own language. Every word of body text must be the document's wording, character for character where the source is legible.",
  'Restore the heading hierarchy with `#` through `####`, using the visual hierarchy of the page (size, weight, numbering) to decide the level.',
  'Render tables as GitHub-flavored markdown tables. Keep every cell; if a table spans pages, continue the same table.',
  'Replace each figure, chart, diagram or photograph with a single blockquote line describing it: `> [Figure: what it shows]`. Write the placeholder word in the language of the document (for example `> [그림: …]` in Korean, `> [図: …]` in Japanese, `> [Figure: …]` in English). Never invent data that is only shown graphically.',
  'Drop running headers, running footers, page numbers, and watermark text. They are page furniture, not content.',
  'Keep lists as markdown lists, keep emphasis, and keep footnotes as ordinary text at the point where the footnote appears.',
  'Output markdown only. No preamble, no closing remark, and do not wrap the whole answer in a code fence.',
].join('\n');

/** Builds the single user-message text that accompanies the `input_file` part. */
export function buildTranscriptionPrompt(params: TranscriptionPromptParams): string {
  const parts = [TRANSCRIPTION_RULES, '', `The attached PDF contains ${params.pageRange} of the source document.`];

  if ((params.scannedPages ?? 0) > 0) parts.push(SCAN_INSTRUCTION);

  if (params.isFirstChunk) {
    const hint = params.title?.trim() || stripExtension(params.filename);
    parts.push(
      `Begin the output with exactly one top-level title line (\`# \`). Use the document's own title if it has one; otherwise use "${hint}".`,
    );
  } else {
    const path = (params.previousHeadingPath ?? []).filter((heading) => heading.trim().length > 0);
    if (path.length > 0) {
      parts.push(
        `This is a continuation. The previous chunk ended inside this heading path: ${path
          .map((heading) => `"${heading}"`)
          .join(
            ' > ',
          )}. Continue underneath it — do not repeat those headings, and do not start a new top-level (\`# \`) title.`,
      );
    } else {
      parts.push(
        'This is a continuation of an earlier chunk. Do not start a new top-level (`# `) title and do not repeat content from before this page range.',
      );
    }
    parts.push(
      'If the page range begins mid-sentence or mid-table, continue from where it starts without an introductory line.',
    );
  }

  return parts.join('\n');
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '') || filename;
}
