/**
 * What kind of text was handed to "회의록 만들기".
 *
 * The extension is believed first — a `.vtt` is a WebVTT file even if someone
 * saved prose into it, and arguing with the name only produces surprises. What
 * the extension cannot answer, the content does: a paste has no name at all, and
 * a `.txt` from Zoom and a `.txt` of somebody's notes are the same file to the
 * filesystem and very different to the pipeline.
 *
 * Detection is deliberately not a gate. Guessing `plain` for a real transcript
 * costs structure, not the import: the design says a non-transcript upload is
 * converted anyway (docs/meeting-notes-and-glossary.md, 1단계).
 */

import { readUtteranceHeader } from './segments';

export type TextKind = 'vtt' | 'srt' | 'transcript-text' | 'docx' | 'markdown' | 'plain';

export interface DetectTextInput {
  filename?: string;
  bytes?: Buffer;
  text?: string;
}

/**
 * The share of a file's lines that must look like utterances before it counts
 * as a transcript. From the design ("줄의 60% 이상"): high enough that a document
 * quoting a couple of timestamps is still a document, low enough that the
 * headers, footers and stage directions every export sprinkles in do not sink it.
 */
const TRANSCRIPT_LINE_RATIO = 0.6;

/** Enough lines for a ratio to mean anything. Three cues is not a transcript. */
const MIN_TRANSCRIPT_LINES = 6;

const EXTENSION_KINDS: Record<string, TextKind> = {
  vtt: 'vtt',
  srt: 'srt',
  docx: 'docx',
  md: 'markdown',
  markdown: 'markdown',
};

/** Everything `loadTranscript` will open. Anything else is refused by name. */
export const SUPPORTED_EXTENSIONS = ['vtt', 'srt', 'docx', 'md', 'markdown', 'txt', 'text'] as const;

export function extensionOf(filename: string | undefined): string {
  if (!filename) return '';
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isSupportedTranscriptFile(filename: string | undefined): boolean {
  const extension = extensionOf(filename);
  // No extension is not a refusal: a paste has no name, and neither does a file
  // a browser handed over as `transcript`.
  return extension === '' || (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
}

export function detectTextKind(input: DetectTextInput): TextKind {
  const extension = extensionOf(input.filename);
  const byName = EXTENSION_KINDS[extension];
  // A container we cannot read as text at all — the caller has to unzip it
  // before any content check would mean anything.
  if (byName === 'docx') return 'docx';

  const text = input.text ?? input.bytes?.toString('utf8') ?? '';
  const content = detectFromContent(text);

  // Content wins over `.md`/`.txt` only when it found a transcript: a markdown
  // file that is a Teams export is still a Teams export, while a `.md` with no
  // transcript shape keeps its name's answer.
  if (byName === 'vtt' || byName === 'srt') return byName;
  if (content) return content;
  return byName ?? 'plain';
}

/** The kind the bytes themselves admit to, or `null` for "nothing in particular". */
function detectFromContent(text: string): TextKind | null {
  if (!text.trim()) return null;
  if (/^\uFEFF?\s*WEBVTT\b/.test(text)) return 'vtt';
  if (looksLikeSrt(text)) return 'srt';
  if (transcriptLineRatio(text) >= TRANSCRIPT_LINE_RATIO) return 'transcript-text';
  return null;
}

/**
 * SubRip's giveaway is the numbering: a cue is an integer on its own line
 * immediately above a `-->` timing with comma decimals. WebVTT has the same
 * timing line but no number and a `WEBVTT` header, which is checked first.
 */
function looksLikeSrt(text: string): boolean {
  return /(^|\n)\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(text);
}

/**
 * How much of the file is utterances.
 *
 * Counted by coverage rather than by matching lines, because half the exports in
 * the world put the name and clock on one line and the words on the next
 * (Teams, Otter): matching lines alone tops out at 50% for a perfectly ordinary
 * transcript. A header therefore claims the lines that follow it, up to the next
 * blank line or the next header — which is exactly the block those tools write.
 */
export function transcriptLineRatio(text: string): number {
  const lines = text.split(/\r?\n/);
  let total = 0;
  let covered = 0;
  let inUtterance = false;
  // A header that carried no words of its own is a promise that the next line
  // has them. A blank line in between is not the end of the utterance — it is
  // what a `.docx` full of `<p>` elements turns every line break into.
  let awaitingWords = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (!awaitingWords) inUtterance = false;
      continue;
    }

    total += 1;
    const header = readUtteranceHeader(line);
    if (header) {
      inUtterance = true;
      awaitingWords = header.text === '';
      covered += 1;
      continue;
    }
    if (inUtterance) {
      covered += 1;
      awaitingWords = false;
    }
  }

  if (total < MIN_TRANSCRIPT_LINES) return 0;
  return covered / total;
}
