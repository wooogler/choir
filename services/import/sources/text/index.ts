/**
 * Text in, utterances out.
 *
 * The one entry point the meeting pipeline uses: it takes whatever the dialog
 * sent — an uploaded file or a paste — and answers with segments, statistics and
 * the kind it decided on, or refuses in a way the route can hand straight to the
 * manager. Nothing here calls a model or touches the network.
 *
 * See docs/meeting-notes-and-glossary.md, "변환 파이프라인".
 */

import { ImportRefusal } from 'services/import/types';
import { type TextKind, detectTextKind, isSupportedTranscriptFile } from './detect';
import {
  type Segment,
  type TranscriptStats,
  parseSrt,
  parseTranscriptText,
  parseVtt,
  plainToSegments,
  transcriptStats,
} from './segments';

export { detectTextKind, extensionOf, isSupportedTranscriptFile, SUPPORTED_EXTENSIONS } from './detect';
export type { DetectTextInput, TextKind } from './detect';
export {
  mergeSegments,
  parseSrt,
  parseTimestamp,
  parseTranscriptText,
  parseVtt,
  plainToSegments,
  readUtteranceHeader,
  transcriptStats,
} from './segments';
export type { Segment, TranscriptStats, UtteranceHeader } from './segments';

/**
 * Five megabytes of text.
 *
 * A three-hour transcript is under one, so this is not a budget anyone meets by
 * accident — it is the ceiling that stops a mis-picked file from being decoded,
 * segmented and held in memory before anything notices. Much lower than the
 * PDF's 20MB because that one is a compressed container and this one is prose.
 */
export const TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;

export interface LoadTranscriptInput {
  filename?: string;
  bytes?: Buffer;
  text?: string;
}

export interface LoadedTranscript {
  kind: TextKind;
  segments: Segment[];
  stats: TranscriptStats;
  /** What a `.docx` turned into, kept so the preview can show what was read. */
  markdown?: string;
}

export async function loadTranscript(input: LoadTranscriptInput): Promise<LoadedTranscript> {
  if (!isSupportedTranscriptFile(input.filename)) {
    throw new ImportRefusal(415, 'import_unsupported_file');
  }

  const size = input.bytes?.length ?? Buffer.byteLength(input.text ?? '', 'utf8');
  if (size > TRANSCRIPT_MAX_BYTES) {
    throw new ImportRefusal(413, 'import_too_large', { maxMb: Math.round(TRANSCRIPT_MAX_BYTES / (1024 * 1024)) });
  }

  const kind = detectTextKind(input);

  if (kind === 'docx') {
    if (!input.bytes?.length) throw new ImportRefusal(422, 'meeting_transcript_empty');
    // Loaded here rather than at the top of the file, the way the import route
    // loads the web source: `docx.ts` pulls in mammoth and — through
    // `htmlToMarkdown` — JSDOM, and a paste should never pay for either.
    const { docxToMarkdown } = await import('./docx');
    const markdown = await docxToMarkdown(input.bytes);
    // Detection runs again on the words, not on the zip: what matters is whether
    // the document someone tidied up in Word is still a transcript underneath.
    // The synthetic `.md` name is honest — by this point it *is* markdown — and
    // it is what makes a Word document that is only a document say so.
    return finish(detectTextKind({ filename: 'converted.md', text: markdown }), markdown, markdown);
  }

  const text = decode(input);
  return finish(kind, text);
}

/** Segments for a kind, plus the refusal that an empty transcript earns. */
function finish(kind: TextKind, text: string, markdown?: string): LoadedTranscript {
  const segments = segmentsFor(kind, text);
  if (segments.length === 0) {
    // Not "we could not parse it": there was nothing to parse. Both a blank
    // paste and a file of nothing but timestamps land here, and both are the
    // same thing to the manager — check the file.
    throw new ImportRefusal(422, 'meeting_transcript_empty');
  }

  return { kind, segments, stats: transcriptStats(segments), markdown };
}

function segmentsFor(kind: TextKind, text: string): Segment[] {
  switch (kind) {
    case 'vtt':
      return parseVtt(text);
    case 'srt':
      return parseSrt(text);
    case 'transcript-text':
      return parseTranscriptText(text);
    default:
      return plainToSegments(text);
  }
}

/** UTF-8 with the byte-order mark off, which Windows exports routinely carry. */
function decode(input: LoadTranscriptInput): string {
  const raw = input.text ?? input.bytes?.toString('utf8') ?? '';
  return raw.replace(/^\uFEFF/, '');
}
