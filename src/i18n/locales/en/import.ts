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
} as const;
