/**
 * What the model is told, and how its answer is read back.
 *
 * Two prompts, because a meeting note is a map-reduce: every chunk is cleaned
 * and summarised on its own (the map), and one last call turns the summaries
 * into 요약·결정 사항·할 일·논의 (the reduce). The split is not an optimisation —
 * an hour of talk does not fit in one request, and a model asked to summarise
 * what it has not seen invents.
 *
 * The map prompt's rule is the same one the PDF path lives by: transcribe, do
 * not write. A cleaned record that reads better than the meeting is a record
 * nobody can check, and `fidelityScore` can only measure text that was meant to
 * survive.
 *
 * See docs/meeting-notes-and-glossary.md, "변환 파이프라인" and 용어집 §5.
 */

import type { GlossaryLanguage } from 'services/glossary/parse';
import { stripCodeFence } from '../pdf/llm-convert';

/** Blocks the chunk answer ends with, in this order. Parsed, then removed. */
const CHUNK_SUMMARY_TAG = 'chunk-summary';
const UNKNOWN_TERMS_TAG = 'unknown-terms';

export interface MeetingPromptContext {
  participants: string[];
  /** The manager's one line: "CHOIR 주간 회의". */
  context?: string;
  /** Already-rendered glossary block, or `''`. */
  glossaryBlock?: string;
  /**
   * Spellings the project knows refer to one person, without saying who — the
   * project file stores aliases under Slack user IDs and deliberately keeps no
   * names (docs/project-folders.md). Groups still help: they tell the model that
   * `상욱` and `SW` in this transcript are the same speaker.
   */
  aliasGroups?: string[][];
  /**
   * Label → participant the server already resolved. The model is told to use
   * these verbatim so the record does not drift between chunks.
   */
  speakerMap?: Record<string, string>;
  language?: GlossaryLanguage;
}

export interface ChunkPromptParams extends MeetingPromptContext {
  /** 1-based, so the model knows whether it is continuing. */
  index: number;
  total: number;
  /** The chunk's utterances, one per line, as the source wrote them. */
  transcript: string;
}

const CHUNK_RULES = [
  'You are cleaning up the transcript of a real meeting for a documentation repository. Clean it — do not summarize it, do not shorten it, and do not translate it.',
  'Keep the content of every utterance. Nothing a person said may be dropped, merged away or replaced with a description of it.',
  'Remove timestamps, filler ("um", "어", "그"), stutters, repeated false starts and transcription noise. That is the only thing you may remove.',
  "Write in the meeting's own language, in the speakers' own words.",
  'Fix mis-transcribed proper nouns, product names and jargon using the glossary below. A term that is not in the glossary stays exactly as transcribed.',
  'Format every utterance as `**Name**: what they said`, one per line, with a blank line between them.',
  'Insert a `## ` subheading naming the topic wherever the meeting clearly moves to a new one. Do not add any other headings.',
  'Output markdown only. No preamble, no closing remark, and do not wrap the answer in a code fence.',
].join('\n');

export function buildChunkPrompt(params: ChunkPromptParams): string {
  const parts: string[] = [CHUNK_RULES, ''];

  if (params.total > 1) {
    parts.push(
      `This is part ${params.index} of ${params.total} of one meeting. Clean only what is below; do not recap earlier parts and do not announce the part number.`,
    );
  }

  parts.push(...contextLines(params));

  parts.push(
    '',
    'After the cleaned record, and only then, add these two blocks:',
    `<${CHUNK_SUMMARY_TAG}>`,
    '- 3 to 6 bullet points: what was discussed, what was decided, and what anybody was asked to do. Name the person for anything assigned.',
    `</${CHUNK_SUMMARY_TAG}>`,
    `<${UNKNOWN_TERMS_TAG}>`,
    '- one line per proper noun, acronym or piece of jargon that is NOT in the glossary above and that you were unsure how to write. Leave it exactly as it was transcribed. Write nothing between the tags if there were none.',
    `</${UNKNOWN_TERMS_TAG}>`,
    '',
    'Transcript:',
    params.transcript,
  );

  return parts.join('\n');
}

export interface ReducePromptParams extends MeetingPromptContext {
  /** Every chunk's `<chunk-summary>`, in order. */
  summaries: string[];
}

const REDUCE_RULES = [
  'You are writing the structured part of a meeting note from the notes taken while cleaning its transcript.',
  'Answer with one JSON object and nothing else. No prose, no code fence.',
  'Shape: {"summary": string[], "decisions": string[], "actionItems": [{"task": string, "owner"?: string, "due"?: string}], "discussion": [{"topic": string, "points": string[]}]}',
  '`summary`: at most 5 short sentences covering the whole meeting.',
  '`decisions`: only things the meeting actually settled. An empty array if it settled nothing.',
  '`actionItems`: only work somebody was actually asked to do. `owner` is a plain person name as written below — never a Slack mention, never an @handle, never an ID. `due` is a date or a phrase the meeting used; leave it out if none was given.',
  '`discussion`: one entry per topic, in the order the meeting took them, each with a short `topic` and its `points`.',
  "Write every value in the meeting's own language. Invent nothing: if the notes do not say it, it does not go in.",
].join('\n');

export function buildReducePrompt(params: ReducePromptParams): string {
  return [
    REDUCE_RULES,
    ...contextLines(params),
    '',
    'Notes, in order:',
    params.summaries.map((summary, index) => `--- part ${index + 1} ---\n${summary.trim()}`).join('\n'),
  ].join('\n');
}

/**
 * The lines both prompts share: who was there, what the meeting was, how this
 * organization spells its own words. Identical in both so the reduce step names
 * people the same way the record does.
 */
function contextLines(params: MeetingPromptContext): string[] {
  const lines: string[] = [];

  if (params.context) lines.push('', `What this meeting is: ${params.context}`);

  if (params.participants.length > 0) {
    lines.push(
      '',
      `Participants, spelled as they must appear: ${params.participants.join(', ')}.`,
      'Map a speaker label to one of these names when the labels, the aliases or the conversation make it certain. When it is not certain, keep the label exactly as the transcript wrote it — a wrong name is worse than `Speaker 2`.',
    );
  }

  const resolved = Object.entries(params.speakerMap ?? {});
  if (resolved.length > 0) {
    lines.push(
      `These speaker labels are already known: ${resolved.map(([from, to]) => `${from} = ${to}`).join('; ')}.`,
    );
  }

  const groups = (params.aliasGroups ?? []).filter((group) => group.filter((alias) => alias.trim()).length > 1);
  if (groups.length > 0) {
    lines.push(`Each group of spellings refers to one person: ${groups.map((group) => group.join(' = ')).join('; ')}.`);
  }

  if (params.glossaryBlock?.trim()) lines.push('', params.glossaryBlock.trim());

  return lines;
}

// ── Reading the answers ────────────────────────────────────────────────────

export interface ChunkOutput {
  /** The cleaned record, with both trailing blocks removed. */
  record: string;
  summary: string[];
  unknownTerms: string[];
}

/**
 * Splits a chunk answer into its three parts.
 *
 * Tolerant by design: a missing block is an empty list, not a failure. The
 * record is the expensive part and the only one that cannot be recovered by
 * asking again, so nothing about the bookkeeping blocks may throw it away.
 */
export function parseChunkOutput(text: string): ChunkOutput {
  const body = stripCodeFence(text ?? '');
  const summary = bulletsIn(blockContent(body, CHUNK_SUMMARY_TAG));
  const unknownTerms = bulletsIn(blockContent(body, UNKNOWN_TERMS_TAG));

  const record = body
    .replace(blockPattern(CHUNK_SUMMARY_TAG), '')
    .replace(blockPattern(UNKNOWN_TERMS_TAG), '')
    // A model that opened a block and never closed it leaves the tag behind;
    // an orphan tag in a committed document is worse than a lost summary.
    .replace(new RegExp(String.raw`</?(?:${CHUNK_SUMMARY_TAG}|${UNKNOWN_TERMS_TAG})>`, 'gi'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { record, summary, unknownTerms };
}

export interface ReduceOutput {
  summary: string[];
  decisions: string[];
  actionItems: Array<{ task: string; owner?: string; due?: string }>;
  discussion: Array<{ topic: string; points: string[] }>;
}

/**
 * Reads the reduce step's JSON, or answers with empty sections.
 *
 * The record is already in hand when this runs, so a malformed answer must cost
 * the analysis and not the note: empty sections render as "없음", which is both
 * true and editable, while a throw would lose an hour of cleaned transcript.
 */
export function parseReduceOutput(text: string): ReduceOutput {
  const empty: ReduceOutput = { summary: [], decisions: [], actionItems: [], discussion: [] };

  const json = firstJsonObject(stripCodeFence(text ?? ''));
  if (!json) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const raw = parsed as Record<string, unknown>;

  return {
    summary: stringList(raw.summary),
    decisions: stringList(raw.decisions),
    actionItems: toArray(raw.actionItems)
      .map((entry) => {
        const item = entry as Record<string, unknown>;
        const task = asText(item?.task);
        if (!task) return null;
        const owner = plainName(asText(item?.owner));
        const due = asText(item?.due);
        return { task, ...(owner ? { owner } : {}), ...(due ? { due } : {}) };
      })
      .filter((item): item is { task: string; owner?: string; due?: string } => item !== null),
    discussion: toArray(raw.discussion)
      .map((entry) => {
        const topic = entry as Record<string, unknown>;
        return { topic: asText(topic?.topic), points: stringList(topic?.points) };
      })
      .filter((topic) => topic.topic || topic.points.length > 0),
  };
}

/**
 * An owner is a name a GitHub reader can read. A model that answers `<@U123>`
 * or `@minji` anyway is stripped rather than obeyed: 결정 — "할 일 담당자는 이름
 * 텍스트만" — and a Slack ID in a committed document means nothing to anyone.
 */
function plainName(value: string): string {
  return value
    .replace(/<@[^>]+>/g, '')
    .replace(/^@+/, '')
    .trim();
}

function blockPattern(tag: string): RegExp {
  return new RegExp(String.raw`<${tag}>[\s\S]*?(?:</${tag}>|$)`, 'i');
}

function blockContent(text: string, tag: string): string {
  const match = new RegExp(String.raw`<${tag}>([\s\S]*?)(?:</${tag}>|$)`, 'i').exec(text);
  return match ? match[1] : '';
}

/** Bullet lines, with the marker off. A model that answered in plain lines still counts. */
function bulletsIn(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/** The outermost `{…}` in an answer that may have prose around it. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return toArray(value)
    .map((entry) => asText(entry))
    .filter((entry) => entry.length > 0);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
