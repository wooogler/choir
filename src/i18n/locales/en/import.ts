/**
 * The one line CHOIR writes into a document it imported.
 *
 * Unlike the rest of this catalog, these strings are not UI: they are committed
 * into somebody's repository, read by whoever opens the file, and indexed for
 * search. So they follow the workspace's *content* language rather than the
 * reader's UI language (`pickDocumentLanguage` in services/import/source-note.ts),
 * and they stay short enough to survive being the first thing under the title.
 *
 * `{date}` is always `YYYY-MM-DD`: unambiguous in every locale, and stable if
 * the sentence around it is ever retranslated.
 */

export const importStrings = {
  // ── Source note (services/import/source-note.ts) ────────────────────────
  'import.sourceNote.url': 'Source: {url} (imported {date})',
  'import.sourceNote.file': 'Source: {name} (imported {date})',
  'import.sourceNote.fileWithPages': 'Source: {name} ({pages}, imported {date})',
  'import.sourceNote.googleDoc': 'Source: Google Doc {name} (imported {date})',
  'import.sourceNote.pages': {
    one: '{count} page',
    other: '{count} pages',
  },
  /** A meeting's detail is a list ("58 minutes, 4 speakers"), not a page count. */
  'import.sourceNote.fileWithDetail': 'Source: {name} ({detail}, imported {date})',
  'import.sourceNote.minutes': {
    one: '{count} minute',
    other: '{count} minutes',
  },
  'import.sourceNote.speakers': {
    one: '{count} speaker',
    other: '{count} speakers',
  },

  // ── Meeting note template (services/import/sources/meeting/template.ts) ──
  // Headings and table labels of a generated meeting note. Document text, so
  // they follow the same content-language rule as the source note above.
  'meeting.section.summary': 'Summary',
  'meeting.section.decisions': 'Decisions',
  'meeting.section.actionItems': 'Action items',
  'meeting.section.discussion': 'Discussion',
  'meeting.section.fullRecord': 'Full record',
  'meeting.section.date': 'Date',
  'meeting.section.participants': 'Participants',
  'meeting.section.related': 'Related',
  /** Column headers of the action-item table, under `meeting.section.actionItems`. */
  'meeting.section.actionTask': 'Task',
  'meeting.section.actionOwner': 'Owner',
  'meeting.section.actionDue': 'Due',
  /** What a section says when the meeting produced nothing for it. */
  'meeting.section.none': 'None',
} as const;
