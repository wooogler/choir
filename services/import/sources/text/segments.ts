/**
 * A transcript, whatever tool produced it, as a list of utterances.
 *
 * Every downstream step wants the same three things — who spoke, when, and what
 * they said — and nothing wants to know that Zoom writes the timestamp first
 * while Teams writes it after the name. So the format differences end here, and
 * the chunker, the prompts and the estimate all read `Segment[]`.
 *
 * The line grammar is shared with `detect.ts`: what makes a line the start of an
 * utterance is exactly what makes a file look like a transcript, and two copies
 * of that judgement would drift.
 *
 * See docs/meeting-notes-and-glossary.md, "변환 파이프라인".
 */

export interface Segment {
  /** The label the source used — a real name, `Speaker 1`, or absent. */
  speaker?: string;
  /** Seconds from the start of the recording. */
  start?: number;
  /**
   * When the utterance ended, for the formats that say so (VTT, SRT). Only the
   * duration label on the source note reads it — without it an hour-long
   * meeting whose last speaker talked for two minutes is reported as 58.
   */
  end?: number;
  text: string;
}

export interface TranscriptStats {
  /** Distinct speaker labels, in the order they first spoke. */
  speakers: string[];
  utterances: number;
  /** Absent when the source carried no clock (a pasted wall of text). */
  durationSeconds?: number;
  chars: number;
}

/**
 * How much of one speaker's run may be merged into a single segment.
 *
 * Merging exists so a caption file's three-second cues do not become three
 * hundred utterances, but a whole hour of one person with no interruption would
 * become one unsplittable segment — and the chunker cuts on segment boundaries.
 * A thousand characters is well under a chunk and well over a cue.
 */
const MERGE_MAX_CHARS = 1000;

// ── Line grammar ───────────────────────────────────────────────────────────

/** `0:12`, `00:12:03`, `00:12:03.450` — hours optional, fraction optional. */
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?`;

/** A speaker label is a name, not a sentence: short, and without prose punctuation. */
const NAME = String.raw`[^\r\n:|<>]{1,60}?`;

/**
 * The forms an utterance can open with, most specific first. Each captures
 * `speaker`, `time` and `text` where it has them.
 *
 * The order matters: `Zoom` (time, then name, then text on one line) must be
 * tried before the bare `time text` form, which would otherwise swallow the
 * name into the text.
 */
const HEADERS: RegExp[] = [
  // Zoom / generic: `00:12:03 Sangwook Lee: let's start` — also `[00:12] Name: …`.
  new RegExp(String.raw`^\s*\[?(?<time>${TIME})\]?\s+(?<speaker>${NAME})\s*:\s*(?<text>.*)$`),
  // Clova Note: `참석자 1 00:12 그럼 시작하죠` — name first, no colon.
  new RegExp(String.raw`^\s*(?<speaker>${NAME})\s+\[?(?<time>${TIME})\]?\s+(?<text>\S.*)$`),
  // Teams / Otter: `Sangwook Lee   0:12` on its own line, the words below it.
  new RegExp(String.raw`^\s*(?<speaker>${NAME})\s+\[?(?<time>${TIME})\]?\s*$`),
  // A bare timestamp line, the shape a caption export without names has.
  new RegExp(String.raw`^\s*\[?(?<time>${TIME})\]?\s*$`),
  // `00:12 let's start` — a timestamp and the words, no name anywhere.
  new RegExp(String.raw`^\s*\[?(?<time>${TIME})\]?\s+(?<text>\S.*)$`),
  // `Sangwook Lee: let's start` — a transcript with no clock at all.
  new RegExp(String.raw`^\s*(?<speaker>${NAME})\s*:\s+(?<text>\S.*)$`),
];

export interface UtteranceHeader {
  speaker?: string;
  start?: number;
  /** What was left on the header line; empty when the words are on the next line. */
  text: string;
  /** True when this line carried a clock, which is the strong transcript signal. */
  timed: boolean;
}

/**
 * Reads a line as the opening of an utterance, or answers `null`.
 *
 * Exported for `detect.ts`, which counts how many of a file's lines this
 * recognizes rather than keeping a second, differently-wrong idea of the same
 * question.
 */
export function readUtteranceHeader(line: string): UtteranceHeader | null {
  if (!line.trim()) return null;

  for (const pattern of HEADERS) {
    const match = pattern.exec(line);
    if (!match?.groups) continue;

    const speaker = cleanSpeaker(match.groups.speaker);
    const time = match.groups.time;
    // A "name" that is a whole sentence is prose with a colon in it, not a
    // label: `Note: remember to file the report` must not become a speaker.
    if (speaker !== undefined && !looksLikeName(speaker)) continue;
    if (speaker === undefined && !time) continue;

    return {
      speaker,
      start: time ? parseTimestamp(time) : undefined,
      text: (match.groups.text ?? '').trim(),
      timed: Boolean(time),
    };
  }

  return null;
}

/**
 * A label rather than a sentence. Tools write `Speaker 1`, `참석자 2`,
 * `Sangwook Lee`, `이상욱 (호스트)`; prose that happens to contain a colon
 * writes clauses, which run long and carry sentence punctuation.
 */
function looksLikeName(candidate: string): boolean {
  if (candidate.length > 40) return false;
  if (/[.!?,;]/.test(candidate)) return false;
  // Markdown structure with a colon in it — `**Note**`, `- item`, `> quote`.
  if (/^[#>*_\-+\d]+\s/.test(candidate) || /^\*\*/.test(candidate)) return false;
  // A handful of words at most. Korean names are one; `Dr. Kim Minji` is three.
  return candidate.split(/\s+/).filter(Boolean).length <= 5;
}

function cleanSpeaker(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed : undefined;
}

/** `HH:MM:SS.mmm`, `MM:SS`, either separator for the fraction. Seconds out. */
export function parseTimestamp(value: string): number | undefined {
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) return undefined;

  const [, hours, minutes, seconds, fraction] = match;
  // Two groups is `MM:SS`, three is `HH:MM:SS`. The regex puts the optional
  // leading group first, so its absence is what distinguishes them.
  const total =
    Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction ?? 0}`.slice(0, 6));
  return Number.isFinite(total) ? total : undefined;
}

// ── Parsers ────────────────────────────────────────────────────────────────

/** WebVTT. Cue settings, `NOTE`/`STYLE`/`REGION` blocks and voice tags all go. */
export function parseVtt(text: string): Segment[] {
  const segments: Segment[] = [];

  for (const block of blocksOf(text)) {
    const first = block[0] ?? '';
    if (/^\uFEFF?WEBVTT/.test(first) || /^(NOTE|STYLE|REGION)\b/.test(first)) continue;

    // An optional cue identifier sits above the timing line.
    const timingIndex = block.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const timing = parseCueTiming(block[timingIndex]);
    const body = block.slice(timingIndex + 1).join('\n');
    const cue = readCueText(body);
    if (!cue.text) continue;

    segments.push({ speaker: cue.speaker, start: timing?.start, end: timing?.end, text: cue.text });
  }

  return mergeSegments(segments);
}

/** SubRip. Same shape as VTT once the cue number and the comma decimals are off. */
export function parseSrt(text: string): Segment[] {
  const segments: Segment[] = [];

  for (const block of blocksOf(text)) {
    const timingIndex = block.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const timing = parseCueTiming(block[timingIndex]);
    const cue = readCueText(block.slice(timingIndex + 1).join('\n'));
    if (!cue.text) continue;

    segments.push({ speaker: cue.speaker, start: timing?.start, end: timing?.end, text: cue.text });
  }

  return mergeSegments(segments);
}

/**
 * The plain-text exports: Zoom, Teams, Clova Note, Otter.
 *
 * One walk, driven by {@link readUtteranceHeader}: a header opens an utterance
 * and every following line that is not itself a header belongs to it. That is
 * what lets one function read both "everything on one line" (Zoom) and "name and
 * clock, then the words below" (Teams) without knowing which it was given.
 */
export function parseTranscriptText(text: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = readUtteranceHeader(line);
    if (header) {
      if (current?.text.trim()) segments.push(current);
      current = { speaker: header.speaker, start: header.start, text: header.text };
      continue;
    }

    if (!current) {
      // Text before the first header — a title line, or an export that opens
      // with prose. It is content, so it is kept as a speaker-less utterance.
      current = { text: line };
      continue;
    }
    current.text = current.text ? `${current.text} ${line}` : line;
  }

  if (current?.text.trim()) segments.push(current);
  return mergeSegments(segments);
}

/**
 * Anything with no transcript shape at all: paragraphs, one segment each.
 *
 * Not one segment for the whole document, because the chunker can only cut
 * between segments and a pasted hour of notes has to fit in a request.
 */
export function plainToSegments(text: string): Segment[] {
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => ({ text: paragraph }));
}

/**
 * Joins consecutive utterances by the same speaker.
 *
 * A caption file cuts a sentence every few seconds; left alone those become
 * hundreds of one-line "utterances" and the model is asked to clean a transcript
 * that has no sentences in it. The `start` kept is the run's first — when the
 * speaker began, which is what a reader means by it.
 */
export function mergeSegments(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];

  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const previous = merged[merged.length - 1];
    const sameSpeaker = previous && (previous.speaker ?? '') === (segment.speaker ?? '');
    if (previous && sameSpeaker && previous.text.length + text.length <= MERGE_MAX_CHARS) {
      previous.text = `${previous.text} ${text}`;
      previous.end = segment.end ?? segment.start ?? previous.end;
      continue;
    }

    merged.push({ ...segment, text });
  }

  return merged;
}

export function transcriptStats(segments: Segment[]): TranscriptStats {
  const speakers: string[] = [];
  let chars = 0;
  let last: number | undefined;

  for (const segment of segments) {
    if (segment.speaker && !speakers.includes(segment.speaker)) speakers.push(segment.speaker);
    chars += segment.text.length;
    const moment = segment.end ?? segment.start;
    if (typeof moment === 'number') last = Math.max(last ?? 0, moment);
  }

  return { speakers, utterances: segments.length, durationSeconds: last, chars };
}

// ── Cue helpers ────────────────────────────────────────────────────────────

/** Blocks separated by a blank line, each already split into non-empty lines. */
function blocksOf(text: string): string[][] {
  return text
    .split(/\r?\n\s*\r?\n+/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    )
    .filter((block) => block.length > 0);
}

function parseCueTiming(line: string): { start?: number; end?: number } | null {
  const match = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(line);
  if (!match) return null;
  return { start: parseTimestamp(match[1]), end: parseTimestamp(match[2]) };
}

/**
 * A cue's words, and the speaker the cue named.
 *
 * WebVTT says a speaker with `<v Name>`; both formats also carry the plain
 * `Name: words` convention, which is what most exporters actually write. Any
 * other markup (`<i>`, `<c.colorE5E5E5>`, `{\an8}`) is styling and goes.
 */
function readCueText(body: string): { speaker?: string; text: string } {
  let speaker: string | undefined;

  const voice = /<v(?:\.[^\s>]+)*\s+([^>]*)>/i.exec(body);
  if (voice) speaker = cleanSpeaker(voice[1]);

  let text = body
    .replace(/<\/?[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!speaker) {
    const named = /^([^\r\n:|<>]{1,40}?)\s*:\s+(\S.*)$/.exec(text);
    if (named && looksLikeName(named[1].trim())) {
      speaker = cleanSpeaker(named[1]);
      text = named[2].trim();
    }
  }

  return { speaker, text };
}
