/**
 * The meeting note itself: the document that gets committed.
 *
 * A pure function on purpose. Everything uncertain — what was decided, who owes
 * what — was settled by the time it gets here; this only decides shape, and
 * shape is what the retrieval index, the viewer and the next reader depend on
 * being the same every time.
 *
 * The metadata table is the manager's own input, word for word. The model never
 * writes a cell of it (docs/meeting-notes-and-glossary.md, 산출물): a date or a
 * participant list that was inferred is worse than none, because it reads
 * exactly like one that was checked.
 *
 * The source note is NOT here — `source-note.ts` prepends it at commit time, so
 * a manager who deletes it in the preview does not get it back.
 */

import { type Locale, translate } from '../../../../src/i18n';
import type { MeetingMeta } from './meta';

export interface MeetingActionItem {
  task: string;
  owner?: string;
  due?: string;
}

export interface MeetingDiscussionTopic {
  topic: string;
  points: string[];
}

export interface MeetingSections {
  summary: string[];
  decisions: string[];
  actionItems: MeetingActionItem[];
  discussion: MeetingDiscussionTopic[];
  /** The cleaned transcript, already formatted as `**Name**: …` lines. */
  fullRecord: string;
}

export interface RenderMeetingNoteParams {
  meta: MeetingMeta;
  /** The document's language, from `pickDocumentLanguage`. */
  language: Locale;
  sections: MeetingSections;
}

export function emptyMeetingSections(fullRecord = ''): MeetingSections {
  return { summary: [], decisions: [], actionItems: [], discussion: [], fullRecord };
}

export function renderMeetingNote(params: RenderMeetingNoteParams): string {
  const { meta, language, sections } = params;
  const parts: string[] = [`# ${meta.title}`, '', metadataTable(meta, language)];

  // "정리된 transcript" is the same document with the analysis left out: same
  // title, same table, so a note can be recognised as one whichever way it was
  // made, and a manager who wants the sections can convert again.
  if (meta.format === 'notes') {
    parts.push('', heading(language, 'meeting.section.summary'), '', bullets(sections.summary, language));
    parts.push('', heading(language, 'meeting.section.decisions'), '', bullets(sections.decisions, language));
    parts.push('', heading(language, 'meeting.section.actionItems'), '', actionItems(sections.actionItems, language));
    parts.push('', heading(language, 'meeting.section.discussion'), '', discussion(sections.discussion, language));
  }

  parts.push('', heading(language, 'meeting.section.fullRecord'), '', sections.fullRecord.trim() || none(language));

  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/**
 * `| 날짜 | 참석자 | 관련 |` — three columns because those are the three things
 * a reader who found this file in a search still needs: when, who, and what it
 * belongs to. `관련` is the manager's one-line context, empty when there is none.
 */
function metadataTable(meta: MeetingMeta, language: Locale): string {
  const headers = [
    translate(language, 'meeting.section.date'),
    translate(language, 'meeting.section.participants'),
    translate(language, 'meeting.section.related'),
  ];
  const row = [meta.date, meta.participants.join(', '), meta.context ?? ''];

  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    `| ${row.map(cell).join(' | ')} |`,
  ].join('\n');
}

function bullets(items: string[], language: Locale): string {
  const lines = items.map((item) => item.trim()).filter(Boolean);
  if (lines.length === 0) return none(language);
  return lines.map((line) => `- ${line}`).join('\n');
}

function actionItems(items: MeetingActionItem[], language: Locale): string {
  const rows = items.filter((item) => item.task?.trim());
  // An empty GFM table renders as nothing at all in most viewers, so a meeting
  // that assigned no work says so in words rather than showing bare pipes.
  if (rows.length === 0) return none(language);

  const headers = [
    translate(language, 'meeting.section.actionTask'),
    translate(language, 'meeting.section.actionOwner'),
    translate(language, 'meeting.section.actionDue'),
  ];

  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((item) => `| ${[item.task, item.owner ?? '', item.due ?? ''].map(cell).join(' | ')} |`),
  ].join('\n');
}

function discussion(topics: MeetingDiscussionTopic[], language: Locale): string {
  const kept = topics.filter((topic) => topic.topic?.trim() || topic.points?.some((point) => point.trim()));
  if (kept.length === 0) return none(language);

  return kept
    .map((topic) => {
      const heading = topic.topic?.trim();
      const points = bulletsOrEmpty(topic.points ?? []);
      // `###` because `##` is the section: a topic is a subheading of 논의, and
      // a flat hierarchy would put every topic beside 요약 in the outline.
      return heading ? [`### ${heading}`, '', points].filter(Boolean).join('\n') : points;
    })
    .filter(Boolean)
    .join('\n\n');
}

function bulletsOrEmpty(items: string[]): string {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join('\n');
}

type SectionKey =
  | 'meeting.section.summary'
  | 'meeting.section.decisions'
  | 'meeting.section.actionItems'
  | 'meeting.section.discussion'
  | 'meeting.section.fullRecord';

function heading(language: Locale, key: SectionKey): string {
  return `## ${translate(language, key)}`;
}

function none(language: Locale): string {
  return translate(language, 'meeting.section.none');
}

/** A `|` in a name or a task would split the row into a column that is not there. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}
