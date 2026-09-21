/**
 * The meeting information the manager typed, checked before anything is spent.
 *
 * The whole point of "회의록 만들기" is that these facts come from a person and
 * not from the model (docs/meeting-notes-and-glossary.md, 결정 2): the title, the
 * date, the folder, the participants and the one-line context are what make the
 * transcript findable afterwards, and a model guessing them from the words is
 * exactly how a meeting note ends up filed under the wrong project.
 *
 * So this module is a gate with a message. `meeting_meta_invalid` carries a
 * `{message}` the dialog shows next to the field, which means every refusal here
 * has to be readable by the person who typed the value.
 */

import { normalizeDocumentPath } from 'services/docs-editor/document-path';
import type { ParseResult } from 'services/projects/schema';

export type MeetingFormat = 'notes' | 'transcript';

export interface MeetingMeta {
  title: string;
  /** `YYYY-MM-DD`, the day the meeting happened — not the day it was imported. */
  date: string;
  /** Repository-relative folder, no leading or trailing slash. `''` is the root. */
  folder: string;
  /** Basename only, ending in `.md`. */
  fileName: string;
  participants: string[];
  context?: string;
  format: MeetingFormat;
}

export const MEETING_FORMATS: readonly MeetingFormat[] = ['notes', 'transcript'];

const MAX_TITLE_CHARS = 200;
/** One line of context, as the dialog asks for. Long enough for a sentence. */
const MAX_CONTEXT_CHARS = 500;
/** A meeting with more than this many people is a broadcast, and the list is noise. */
const MAX_PARTICIPANTS = 50;

export function parseMeetingMeta(json: unknown): ParseResult<MeetingMeta> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return fail('Meeting details are missing');
  }
  const raw = json as Record<string, unknown>;

  const title = text(raw.title);
  if (!title) return fail('Give the meeting a title');
  if (title.length > MAX_TITLE_CHARS) return fail(`The title is longer than ${MAX_TITLE_CHARS} characters`);

  const date = text(raw.date);
  if (!isCalendarDate(date)) return fail('Give the meeting date as YYYY-MM-DD');

  const folder = normalizeFolder(raw.folder);
  if (folder === null) return fail('That folder cannot hold a document');

  const fileName = text(raw.fileName);
  if (!fileName) return fail('Give the file a name');
  if (fileName.includes('/') || fileName.includes('\\')) return fail('The file name cannot contain a folder');
  if (!/\.md$/i.test(fileName)) return fail('The file name must end in .md');

  const format = text(raw.format) as MeetingFormat;
  if (!MEETING_FORMATS.includes(format)) return fail('Choose 회의록 or 정리된 transcript');

  const participants = normalizeParticipants(raw.participants);
  if (participants === null) return fail('Participants must be a list of names');
  if (participants.length > MAX_PARTICIPANTS) return fail(`There cannot be more than ${MAX_PARTICIPANTS} participants`);

  const context = text(raw.context);
  if (context.length > MAX_CONTEXT_CHARS)
    return fail(`The context line is longer than ${MAX_CONTEXT_CHARS} characters`);

  const value: MeetingMeta = {
    title,
    date,
    folder,
    fileName,
    participants,
    format,
    ...(context ? { context } : {}),
  };

  // The last word on where a document may land belongs to the same function
  // every other write goes through, rather than to the two checks above: it is
  // what refuses `assets/`, `.choir/` and a `..` that survived normalization.
  if (!normalizeDocumentPath(join(folder, fileName))) {
    return fail('That path cannot hold a document');
  }

  return { ok: true, value };
}

/** Where the note will be committed. Always a path `normalizeDocumentPath` accepts. */
export function meetingTargetPath(meta: MeetingMeta): string {
  return normalizeDocumentPath(join(meta.folder, meta.fileName)) ?? join(meta.folder, meta.fileName);
}

function join(folder: string, fileName: string): string {
  return folder ? `${folder}/${fileName}` : fileName;
}

/**
 * A folder as the dialog may send it — `meetings`, `/meetings/`, `''` for the
 * repository root — or `null` when it is not one. The path check above catches
 * the reserved names; this one only has to produce a canonical string.
 */
function normalizeFolder(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return '';

  const segments = trimmed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

/**
 * Trimmed, empties dropped, duplicates dropped. Case-insensitively, because
 * `이상욱` twice with different spacing is one person in the table and two in
 * the anonymization mapping.
 */
function normalizeParticipants(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== 'string')) return null;

  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of value as string[]) {
    const name = entry.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** A real day, not just four digits and two dashes: `2026-02-31` is not a date. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(message: string): ParseResult<MeetingMeta> {
  return { ok: false, message };
}
