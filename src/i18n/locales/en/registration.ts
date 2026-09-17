/**
 * Strings for the registration feature. Keys: `registration.<surface>.<element>[.<variant>]`.
 *
 * Only the manager-facing request card lives here so far: it is the one
 * registration surface that is read by someone other than the person who acted,
 * so it belongs to the recipient-scoped pass. The requester-facing strings
 * (the approval DM, the response_url replacements) are a later migration.
 */

export const registration = {
  'registration.managerCard.request': '🙋 *{userName}* is requesting access to CHOIR.',
  // The two mutually exclusive halves of the card's context line, joined by a
  // space with the consent reminder below — one key per sentence, so a
  // translator is never asked to reassemble a sentence from fragments.
  'registration.managerCard.origin.channel': 'Asked in {channelLink}.',
  'registration.managerCard.origin.dm': 'Asked in a direct message.',
  'registration.managerCard.consentReminder': "Reminder: check they've completed the {consentFormLink}.",
  'registration.link.consentForm': 'consent form',
  'registration.managerCard.approve.button': '✅ Approve',
  'registration.managerCard.decline.button': 'Decline',
} as const;
