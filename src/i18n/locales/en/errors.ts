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

  // Write failures. `{target}` is the pre-composed "owner/repo (path) on branch"
  // the English was always built from — identifiers, not prose — and `{action}`
  // is the English verb at the throw site ('update', 'commit', 'upload'); a
  // translation is free to drop either and name the repository with `{repo}`
  // instead. `{url}` carries the org policy URL, which never lives in a catalog.
  'errors.github.credentialsRejected':
    'GitHub rejected the stored credentials while trying to {action} {target}. Reconnect your GitHub account from the CHOIR App Home and try again.',
  'errors.github.rateLimited': 'GitHub rate-limited the request to {action} {target}. Wait a moment and try again.',
  'errors.github.oauthAppRestricted':
    "The {owner} organization has not approved CHOIR's GitHub OAuth app, so it cannot {action} {target}. An organization owner must approve it at {url}.",
  'errors.github.ssoRequired':
    'Your GitHub authorization is not enabled for {owner}\'s SAML single sign-on, so CHOIR cannot {action} {target}. Authorize it under your GitHub account\'s "Authorized OAuth Apps" settings, then retry.',
  'errors.github.repoArchived': '{repo} is archived or read-only, so CHOIR cannot {action} {target}.',
  'errors.github.writeForbidden': 'GitHub refused to let the connected account {action} {target}.',
  'errors.github.writeForbiddenDetail':
    'GitHub refused to let the connected account {action} {target}. GitHub said: {detail}',
  'errors.github.noPushAccess':
    'GitHub answered 404 when CHOIR tried to {action} {target}. GitHub reports a missing write permission as 404, so the connected GitHub account almost certainly has no push access to {repo}. Ask a repository admin to grant Write access, or reconnect GitHub from the CHOIR App Home with an account that has it.',
  'errors.github.targetNotFound':
    'GitHub could not find {target}. Check the repository, branch, and file path configured for this workspace.',
  'errors.github.branchMoved':
    'The branch moved while CHOIR was writing {target}, so the {action} was rejected as a conflict. Reload the document and re-apply your change.',
  'errors.github.branchProtected':
    'GitHub rejected the {action} of {target}. A protected branch that requires a pull request is the usual cause.',
  'errors.github.branchProtectedDetail':
    'GitHub rejected the {action} of {target}. A protected branch that requires a pull request is the usual cause. GitHub said: {detail}',
  'errors.github.unavailable':
    'GitHub is unavailable (HTTP {status}), so the {action} of {target} did not go through. Try again shortly.',

  'errors.llm.noApiKey': 'No OpenAI API key configured. Set it from App Home or via OPENAI_API_KEY.',
} as const;
