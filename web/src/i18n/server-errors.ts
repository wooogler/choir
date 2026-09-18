/**
 * Turns the docs API's error codes into sentences in the reader's language.
 *
 * The server cannot write these itself. A write-access `reason` is resolved when
 * the session is read, an NDJSON import line is written while a commit is in
 * flight, and neither is necessarily a request that carried a locale — so the
 * wire carries `{ error: <code> }` and the browser, which knows who is looking
 * at it, picks the words. `GoogleDocsReview` already worked this way for the
 * review statuses and conflict reasons; this is the same pattern applied to
 * everything the API refuses with.
 *
 * The union comes from the server module itself, the way `supported-locales`
 * does: `services/docs-editor/api-errors.ts` is import-free by design, so Vite
 * bundles that one file and none of the node app comes with it. Deleting a code
 * there fails the build here, and `__tests__/docs-api-errors.test.ts` fails if a
 * code exists without a catalog entry.
 */

import type { DocsApiErrorCode } from '../../../services/docs-editor/api-errors';
import type { T } from './translate';
import type { MessageKey, ParamValue } from './types';

export type { DocsApiErrorCode };

/**
 * What the API can send in place of a sentence.
 *
 * Every field is optional because this same reader handles a bare string (a
 * write-access `reason`), a code with details, and the `{ outcome, detail }`
 * bodies the review endpoints have always returned.
 */
export interface ServerErrorPayload {
  /** The code, or — from an older server or an untranslatable domain error — the sentence itself. */
  error?: string;
  /** The English `error` stands for. Shown only when the code is not one we know. */
  message?: string;
  /** Fills the `{name}` holes. A bare string is read as `{message}`. */
  detail?: string | Record<string, ParamValue>;
  /** CHOIR's own domain-error vocabulary (`GITHUB_WRITE_FORBIDDEN`), not this one. */
  code?: string;
}

/**
 * Every code the API can send, and the catalog key that says it.
 *
 * `satisfies Record<DocsApiErrorCode, MessageKey>` is the whole point: a code
 * added on the server with no entry here is a compile error, not a screen with
 * `read_only_document` printed on it.
 */
export const SERVER_ERROR_KEY = {
  internal_error: 'serverError.internal_error',

  unauthorized: 'serverError.unauthorized',
  forbidden: 'serverError.forbidden',
  not_signed_in: 'serverError.not_signed_in',
  workspace_mismatch: 'serverError.workspace_mismatch',
  not_a_manager: 'serverError.not_a_manager',
  manager_access_required: 'serverError.manager_access_required',

  document_path_required: 'serverError.document_path_required',
  file_path_required: 'serverError.file_path_required',
  content_required: 'serverError.content_required',
  commit_message_required: 'serverError.commit_message_required',
  file_path_and_file_id_required: 'serverError.file_path_and_file_id_required',
  file_path_and_content_required: 'serverError.file_path_and_content_required',
  confirm_path_mismatch: 'serverError.confirm_path_mismatch',
  not_markdown_document: 'serverError.not_markdown_document',
  expected_image_body: 'serverError.expected_image_body',
  invalid_language: 'serverError.invalid_language',

  invalid_document_path: 'serverError.invalid_document_path',
  document_exists: 'serverError.document_exists',
  document_not_found: 'serverError.document_not_found',
  record_not_found: 'serverError.record_not_found',
  read_only_document: 'serverError.read_only_document',

  write_access_denied: 'serverError.write_access_denied',
  no_github_repo: 'serverError.no_github_repo',
  github_no_token: 'serverError.github_no_token',
  github_repo_is_archived: 'serverError.github_repo_is_archived',
  github_repo_read_only: 'serverError.github_repo_read_only',
  github_repo_not_visible: 'serverError.github_repo_not_visible',

  github_credentials_rejected: 'serverError.github_credentials_rejected',
  github_rate_limited: 'serverError.github_rate_limited',
  github_oauth_app_restricted: 'serverError.github_oauth_app_restricted',
  github_sso_required: 'serverError.github_sso_required',
  github_repo_archived: 'serverError.github_repo_archived',
  github_write_forbidden: 'serverError.github_write_forbidden',
  github_write_forbidden_detail: 'serverError.github_write_forbidden_detail',
  github_no_push_access: 'serverError.github_no_push_access',
  github_target_not_found: 'serverError.github_target_not_found',
  github_branch_moved: 'serverError.github_branch_moved',
  github_branch_protected: 'serverError.github_branch_protected',
  github_branch_protected_detail: 'serverError.github_branch_protected_detail',
  github_unavailable: 'serverError.github_unavailable',

  image_too_large: 'serverError.image_too_large',
  too_many_images: 'serverError.too_many_images',
  unsupported_image_type: 'serverError.unsupported_image_type',

  google_not_connected: 'serverError.google_not_connected',
  google_picker_not_configured: 'serverError.google_picker_not_configured',
  google_no_access_token: 'serverError.google_no_access_token',
  google_pick_expired_link: 'serverError.google_pick_expired_link',
  google_pick_expired_import: 'serverError.google_pick_expired_import',
  google_doc_missing_in_repo: 'serverError.google_doc_missing_in_repo',
  google_doc_trashed: 'serverError.google_doc_trashed',
  google_doc_already_linked: 'serverError.google_doc_already_linked',
  google_doc_not_linked: 'serverError.google_doc_not_linked',
  github_document_gone: 'serverError.github_document_gone',
  republish_failed: 'serverError.republish_failed',
  review_declined_not_restored: 'serverError.review_declined_not_restored',

  import_invalid_path: 'serverError.import_invalid_path',
  import_path_exists: 'serverError.import_path_exists',
  import_empty: 'serverError.import_empty',
  import_failed: 'serverError.import_failed',
  import_interrupted: 'serverError.import_interrupted',
} as const satisfies Record<DocsApiErrorCode, MessageKey>;

export function isDocsApiErrorCode(value: unknown): value is DocsApiErrorCode {
  return typeof value === 'string' && value in SERVER_ERROR_KEY;
}

/**
 * The sentence to show for whatever the API refused with.
 *
 * Returns `undefined` when there is nothing to say, so the call site keeps its
 * own fallback rather than having one imposed here.
 *
 * An `error` this build does not recognise is passed through verbatim. That is
 * not a gap: a server newer than the bundle, and the GitHub domain errors whose
 * text is assembled from a repository slug, an org policy URL or an SSO prompt,
 * are both better read in English than replaced with "something went wrong".
 */
export function describeServerError(t: T, payload: ServerErrorPayload | string | null | undefined): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  const body: ServerErrorPayload = typeof payload === 'string' ? { error: payload } : payload;

  const params = typeof body.detail === 'string' ? { message: body.detail } : body.detail;

  if (isDocsApiErrorCode(body.error)) {
    return t(SERVER_ERROR_KEY[body.error], params);
  }

  const raw = body.error?.trim() || (typeof body.detail === 'string' ? body.detail.trim() : '') || body.message?.trim();
  return raw || undefined;
}
