/**
 * The error codes Slack is allowed to translate.
 *
 * An error that reaches a person has two audiences and they want different
 * things: the log wants the English sentence that was true at the throw site,
 * the reader wants that sentence in their own language. So a throw carries
 * both — `message` stays English and never moves (tests and logs pin it), and
 * `code` names the catalog entry `errors.<code>` that `describeError` renders
 * instead when the reader is not reading English.
 *
 * A code is only listed here when the entry exists in `src/i18n/locales/*` and
 * the error is worth a person's attention: "you need write access", not
 * "ECONNRESET". Everything else keeps falling through to its English message,
 * which is the honest answer for a failure we cannot phrase as an action.
 *
 * The class extends the existing `CHOIRError` (services/common/error-handler)
 * rather than starting a second hierarchy: `app.ts` already reads `statusCode`
 * and `code` off it, and `services/github/write-error.ts` passes our own
 * `GitHubError`s through untouched. GitHub-side throws therefore stay
 * `GitHubError` and only gain a catalog code — see `satisfies ErrorCode` at
 * those sites.
 */

import { CHOIRError, type ErrorParams } from './error-handler';

/**
 * `<domain>.<code>`, matching the catalog key minus its `errors.` prefix.
 * Adding a member without adding `errors.<member>` to the English catalog is a
 * compile error in `services/i18n/describe-error.ts`.
 */
export type ErrorCode =
  | 'github.privateRepoUnsupported'
  | 'github.writeAccessRequired'
  | 'github.fileAlreadyExists'
  | 'github.concurrentModification'
  | 'github.deviceCodeExpired'
  | 'github.authorizationDenied'
  | 'github.authorizationTimeout'
  | 'llm.noApiKey';

/**
 * A CHOIRError whose `code` is a catalog key, for the domains that have no
 * error class of their own. GitHub keeps `GitHubError` so the write-failure
 * classifier still recognises it.
 */
export class CHOIRUserError extends CHOIRError {
  declare code: ErrorCode;

  constructor(code: ErrorCode, message: string, params?: ErrorParams, statusCode?: number) {
    super(message, code, params, statusCode, params);
    this.name = 'CHOIRUserError';
  }
}
