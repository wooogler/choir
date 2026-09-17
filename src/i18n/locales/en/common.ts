/**
 * Strings shared by every surface: the buttons that appear in most modals, the
 * two errors every handler can hit, and the counted nouns that show up in
 * summaries.
 *
 * Catalogs are plain data on purpose — no imports, no helpers — so they can be
 * read, diffed and (later) machine-translated without running any code. The
 * `as const` is what gives `MessageKey` its compile-time key safety.
 */

export const common = {
  'common.button.cancel': 'Cancel',
  'common.button.confirm': 'Confirm',
  'common.button.close': 'Close',
  'common.button.submit': 'Submit',
  'common.button.back': 'Back',
  'common.error.generic': 'Something went wrong. Please try again.',
  'common.error.managerOnly': 'Only managers can do this.',
  // Stands in for the manager names when there are none to list, or when
  // Slack would not tell us who they are.
  'common.managers': 'managers',
  'common.count.managers': { one: '{count} manager', other: '{count} managers' },
  'common.count.files': { one: '{count} file', other: '{count} files' },
  'common.count.messages': { one: '{count} message', other: '{count} messages' },
} as const;
