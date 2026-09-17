/**
 * Failures a person can do something about.
 *
 * Every other catalog file is named after a surface; this one is named after a
 * layer. Services throw far from Slack — a GitHub write, an OAuth poll, a
 * missing API key — and until now each of those sentences reached the reader
 * as an English `{reason}` embedded in an otherwise translated frame. The
 * throw carries a code instead, and the code is spelled here.
 *
 * Keys are `errors.<domain>.<code>` and mirror the `ErrorCode` union in
 * `services/common/choir-error.ts` exactly: the union is the write side, this
 * file is the read side, and `describeError` refuses to compile if one grows a
 * member the other lacks.
 *
 * The English here matches the thrown `Error.message` word for word. That is
 * not redundancy — the message is what the log keeps and what an English
 * reader was already getting, so keeping them identical means this change
 * moves no English at all. `errors.unknown` is the exception with no code: it
 * is what a non-Error rejection resolves to.
 */

export const errors = {
  'errors.unknown': 'Unknown error',

  'errors.github.privateRepoUnsupported': 'Private repositories are not supported. Please choose a public repository.',
  'errors.github.writeAccessRequired': 'You need write access to connect this repository.',
  'errors.github.fileAlreadyExists': 'File already exists',
  'errors.github.concurrentModification':
    'Concurrent modification of {path} while committing; aborting to avoid overwriting it',
  'errors.github.deviceCodeExpired': 'The device code has expired. Please start the process again.',
  'errors.github.authorizationDenied': 'The user denied the authorization request.',
  'errors.github.authorizationTimeout': 'Polling timeout. The authorization process took too long.',

  'errors.llm.noApiKey': 'No OpenAI API key configured. Set it from App Home or via OPENAI_API_KEY.',
} as const;
