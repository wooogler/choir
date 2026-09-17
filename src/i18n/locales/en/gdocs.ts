/**
 * The Google Docs cards CHOIR sends managers in Slack.
 *
 * Everything here is manager-facing DM text: the drift notice ("someone edited
 * the replica"), the manual-apply request for a document CHOIR will not write
 * to, the two replies its buttons produce, and the status lines that retire a
 * card once its decision can no longer be carried out.
 *
 * Keys are `gdocs.card.*` for what goes into a card and `gdocs.manual.reply.*`
 * for what replaces the clicker's own copy of it. The `card.retired.*` group is
 * the one with an unusual shape: the string is chosen by whoever *caused* the
 * retirement — a delete, an unlink, a rebaseline, a disconnect — but rendered
 * once per recipient, because the people holding those cards may not read the
 * same language as the manager who clicked.
 *
 * `{file}` is a bare file name (`guide.md`) and `{path}` is the repository path
 * (`docs/guide.md`); the two are not interchangeable, and the English picks
 * whichever the surrounding sentence can carry.
 */

export const gdocs = {
  // ── Shared ──────────────────────────────────────────────────────────────
  'gdocs.card.button.openDoc': 'Open Google Doc',

  // ── Drift notice (services/google/drift-notifier.ts) ────────────────────
  'gdocs.card.drift.headline': '✏️ *{file}* was edited in Google Docs.',
  'gdocs.card.drift.editedBy': 'Last edited by {editor}.',
  'gdocs.card.drift.editorUnknown': 'The editor could not be identified.',
  'gdocs.card.drift.held': 'The replica will not be overwritten until this is resolved.',
  'gdocs.card.drift.alsoOnGithub': 'The GitHub side has also changed since the replica was published.',
  'gdocs.card.drift.button.review': 'Review changes',
  'gdocs.card.drift.fallback': '{path} was edited in Google Docs.',

  // ── Manual-apply request (services/google/manual-apply.ts) ──────────────
  'gdocs.card.manual.headline':
    '📝 *{file}* changed in the repository, and this Google Doc keeps its own formatting — so the change has to be made in the Doc by hand.',
  'gdocs.card.manual.note': 'CHOIR does not write to this document, so nothing happens until someone applies it.',
  'gdocs.card.manual.diffTruncated': {
    one: '… {count} more character not shown',
    other: '… {count} more characters not shown',
  },
  'gdocs.card.manual.button.applied': 'I applied it',
  'gdocs.card.manual.button.declined': 'Leave the Doc as is',
  'gdocs.card.manual.fallback': '{path} changed in the repository and needs applying in Google Docs.',

  // ── The clicker's own copy of the card (listeners/features/google-docs) ──
  'gdocs.manual.reply.applied': '✅ {path} — thanks, the Doc and the repository agree now.',
  'gdocs.manual.reply.stillDiffers':
    '⚠️ {path} — the Google Doc still differs from the repository. Apply the change and press the button again.',
  'gdocs.manual.reply.alreadyHandled': 'ℹ️ This was already handled.',
  'gdocs.manual.reply.checkFailed': '⚠️ {path} — could not check the Google Doc ({outcome}). Try again shortly.',
  'gdocs.manual.reply.declined':
    '↩️ {path} — left as it is. The Doc and the repository will differ until somebody changes one of them.',

  // ── Retired cards, rendered per recipient ───────────────────────────────
  'gdocs.card.retired.applied': '✅ {path} — applied in Google Docs by {manager}.',
  'gdocs.card.retired.declined':
    '↩️ {path} — left as it is in Google Docs by {manager}. The repository keeps the change.',
  'gdocs.card.retired.deletedReview': 'This document was deleted, so the pending edit was dropped.',
  'gdocs.card.retired.deletedManual': 'This document was deleted, so there is nothing left to apply in Google Docs.',
  'gdocs.card.retired.unlinkedReview':
    'This document is no longer synced to Google Docs, so the pending edit was dropped.',
  'gdocs.card.retired.unlinkedManual':
    'This document is no longer synced to Google Docs, so there is nothing left to apply.',
  'gdocs.card.retired.republishedReview':
    'A manager republished this document from GitHub, so the pending edit was discarded.',
  'gdocs.card.retired.rebaselinedManual':
    'A manager rebaselined this document, so this request no longer describes it.',
  'gdocs.card.retired.disconnectedReview':
    'The workspace Google account was disconnected, so this pending edit can no longer be applied.',
  'gdocs.card.retired.disconnectedManual':
    'The workspace Google account was disconnected, so these documents are no longer synced.',
} as const;
