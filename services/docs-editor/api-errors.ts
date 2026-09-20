/**
 * The docs viewer's HTTP error vocabulary.
 *
 * The SPA renders these to a reader whose language the server does not always
 * know — an NDJSON import line and a stored write-access `reason` are both
 * written outside any request that carried a locale — so the wire carries a
 * machine-readable code and the browser picks the sentence. `web/src/i18n/
 * server-errors.ts` maps every code below to a catalog key; the root suite
 * `__tests__/docs-api-errors.test.ts` fails if the two ever drift.
 *
 * The English here is not dead weight: it is what `curl` and the server log
 * show, and it is the exact text the `en` catalog repeats, so the viewer reads
 * identically in English before and after this indirection.
 *
 * Deliberately import-free. That is what lets `web/src` pull the union across
 * the workspace boundary the way it already pulls `src/i18n/supported-locales`:
 * Vite bundles this one file and none of the node app comes with it.
 */

/**
 * Every code the docs API may put in `error`, with the English it stands for.
 *
 * `{name}` holes are filled from the response's `detail` object, by the same
 * rules the i18n catalogs use, so a translated sentence can move them around.
 */
export const DOCS_API_ERROR_MESSAGES = {
  // ── Generic ─────────────────────────────────────────────────────────────
  internal_error: 'Internal server error',

  // ── Session and authorization ───────────────────────────────────────────
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  not_signed_in: 'Not signed in',
  workspace_mismatch: 'Session does not match workspace',
  not_a_manager: 'User is not a workspace manager',
  manager_access_required: 'Manager access required',

  // ── Request shape ───────────────────────────────────────────────────────
  document_path_required: 'document path is required',
  file_path_required: 'filePath is required',
  content_required: 'content is required',
  commit_message_required: 'commitMessage is required',
  file_path_and_file_id_required: 'filePath and fileId are required',
  file_path_and_content_required: 'filePath and content are required',
  confirm_path_mismatch: 'The typed path does not match this document',
  not_markdown_document: 'Only markdown documents can be deleted',
  expected_image_body: 'Expected a binary image body',
  invalid_language: 'Unsupported language',

  // ── Documents ───────────────────────────────────────────────────────────
  invalid_document_path: 'Give a repository-relative path ending in .md',
  document_exists: '{path} already exists in this repository',
  document_not_found: 'File not found',
  record_not_found: 'Record not found',
  read_only_document: 'This document is marked read-only. Clear that in App Home before deleting it.',

  // ── Write access ────────────────────────────────────────────────────────
  // The four below are what `probeRepoWriteAccess` answers with before an edit
  // is offered, as opposed to the write-failure vocabulary further down, which
  // classifies a commit GitHub has already refused. `github_repo_is_archived`
  // is not `github_repo_archived` because the two say different things: this
  // one is "you cannot start editing", that one is "your commit was rejected".
  write_access_denied: 'No write access to the workspace repository',
  no_github_repo: 'No GitHub repository is connected to this workspace yet.',
  github_no_token: 'Connect your GitHub account from the CHOIR App Home to edit {repo}.',
  github_repo_is_archived: '{repo} is archived on GitHub, so it cannot be edited.',
  github_repo_read_only:
    'Your GitHub account has read-only access to {repo}. Ask a repository admin for Write access, then reload this page.',
  github_repo_not_visible:
    'Your GitHub account cannot see {repo}. Ask a repository admin to grant you access, then reload this page.',

  // ── GitHub write failures ───────────────────────────────────────────────
  // Classified in services/github/write-error.ts, which owns the mapping from
  // its `ErrorCode` names to these. The English is that module's sentence word
  // for word, with the values it composed from moved into `{name}` holes, so a
  // reader in English sees exactly what the API used to send.
  github_credentials_rejected:
    'GitHub rejected the stored credentials while trying to {action} {target}. Reconnect your GitHub account from the CHOIR App Home and try again.',
  github_rate_limited: 'GitHub rate-limited the request to {action} {target}. Wait a moment and try again.',
  github_oauth_app_restricted:
    "The {owner} organization has not approved CHOIR's GitHub OAuth app, so it cannot {action} {target}. An organization owner must approve it at {url}.",
  github_sso_required:
    'Your GitHub authorization is not enabled for {owner}\'s SAML single sign-on, so CHOIR cannot {action} {target}. Authorize it under your GitHub account\'s "Authorized OAuth Apps" settings, then retry.',
  github_repo_archived: '{repo} is archived or read-only, so CHOIR cannot {action} {target}.',
  github_write_forbidden: 'GitHub refused to let the connected account {action} {target}.',
  github_write_forbidden_detail: 'GitHub refused to let the connected account {action} {target}. GitHub said: {detail}',
  github_no_push_access:
    'GitHub answered 404 when CHOIR tried to {action} {target}. GitHub reports a missing write permission as 404, so the connected GitHub account almost certainly has no push access to {repo}. Ask a repository admin to grant Write access, or reconnect GitHub from the CHOIR App Home with an account that has it.',
  github_target_not_found:
    'GitHub could not find {target}. Check the repository, branch, and file path configured for this workspace.',
  github_branch_moved:
    'The branch moved while CHOIR was writing {target}, so the {action} was rejected as a conflict. Reload the document and re-apply your change.',
  github_branch_protected:
    'GitHub rejected the {action} of {target}. A protected branch that requires a pull request is the usual cause.',
  github_branch_protected_detail:
    'GitHub rejected the {action} of {target}. A protected branch that requires a pull request is the usual cause. GitHub said: {detail}',
  github_unavailable:
    'GitHub is unavailable (HTTP {status}), so the {action} of {target} did not go through. Try again shortly.',

  // ── Google Docs images refused before a commit ──────────────────────────
  // `services/google/gdocs-delta.ts` reports these per dropped image; the SPA
  // joins them into one sentence, so they are fragments, not sentences.
  image_too_large: 'larger than 10MB',
  too_many_images: 'too many new images in one edit',
  unsupported_image_type: 'not a PNG, JPEG, GIF or WebP image',

  // ── Google Drive sync ───────────────────────────────────────────────────
  google_not_connected: 'Connect a Google account first',
  google_picker_not_configured: 'The file picker is not configured (GOOGLE_PICKER_API_KEY, GOOGLE_PROJECT_NUMBER)',
  google_no_access_token: 'Google did not return an access token',
  google_pick_expired_link: 'Pick the document again — this link request has expired',
  google_pick_expired_import: 'Pick the document again — this import request has expired',
  google_doc_missing_in_repo: 'No such document in this workspace',
  google_doc_trashed: 'That document is in the trash',
  google_doc_already_linked: 'Google Doc {fileId} is already linked to {conflictPath}',
  google_doc_not_linked: 'This document is not linked to a Google Doc',
  google_path_already_linked: 'This document already has a Google Doc',
  google_doc_create_failed: 'Could not create the Google Doc: {message}',
  github_document_gone: 'The GitHub document no longer exists. Unlink this replica instead.',
  republish_failed: 'Could not republish this document from GitHub: {message}',
  review_declined_not_restored: 'The document keeps the rejected text until someone reverts it',

  // ── Import ──────────────────────────────────────────────────────────────
  import_invalid_path: 'Give a repository-relative path ending in .md',
  import_path_exists: '{path} already exists in this repository',
  import_empty: 'That document exported as empty',
  import_failed: 'Could not import that document: {message}',
  import_interrupted: 'The import stopped before it finished',

  // ── PDF and web page import ─────────────────────────────────────────────
  // Thrown as `ImportRefusal` by the conversion sources (services/import/
  // sources/**) and answered by services/import/routes.ts with the status the
  // refusal carries. Everything here is something the manager can act on — a
  // file that is too big, a site that said no, an expired preview — as opposed
  // to `import_conversion_failed`, which is the catch-all for a fault of ours.
  import_busy: 'Another import is already running in this workspace — try again in a moment',
  import_unsupported_file: 'Only PDF files can be imported this way',
  import_too_large: 'The file is larger than {maxMb}MB',
  import_too_many_pages: 'The PDF has {pages} pages; the limit is {max}',
  import_too_many_tokens:
    'The PDF is too long to convert in one go ({inputTokens} tokens; the limit is {max}) — split it or narrow the page range',
  import_pdf_encrypted: 'The PDF is password-protected',
  import_pdf_no_text: 'The PDF has no text layer and the LLM conversion is turned off',
  import_url_invalid: 'Give a full http(s) URL',
  import_url_blocked: 'That site refused the request ({status})',
  import_url_unreadable:
    'Nothing readable was found at that URL — for pages that render with JavaScript, save the page as PDF and import that instead',
  import_conversion_failed: 'Could not convert that document: {message}',
  import_draft_expired: 'This import has expired — convert the document again',
  import_llm_unavailable: 'No OpenAI key is configured for this workspace, so PDFs cannot be converted',
} as const;

export type DocsApiErrorCode = keyof typeof DOCS_API_ERROR_MESSAGES;

/** Values a `{name}` hole in the English above (or in a translation) accepts. */
export type DocsApiErrorDetail = Record<string, string | number>;

/**
 * The body every refusal below sends.
 *
 * `error` stays a string so a client written against the old API still has
 * something to show; it is now a code rather than a sentence. `message` is the
 * English that code stands for, for logs and for anyone reading the response by
 * hand. `code` survives where a route already sent one (the CHOIR domain-error
 * codes like `GITHUB_WRITE_FORBIDDEN`) and is not the same vocabulary.
 */
export interface DocsApiErrorBody {
  error: string;
  message: string;
  detail?: DocsApiErrorDetail;
  code?: string;
}

/** Narrowest shape of Express's `res` this module needs. Both `any` (app.ts) and
 *  the hand-written `Res` alias in services/google/routes.ts satisfy it. */
export interface ApiErrorResponder {
  status(code: number): { json(body: unknown): unknown };
}

export function isDocsApiErrorCode(value: unknown): value is DocsApiErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOCS_API_ERROR_MESSAGES, value);
}

/** Fills the English `{name}` holes, so `message` reads as a finished sentence. */
function renderMessage(code: DocsApiErrorCode, detail?: DocsApiErrorDetail): string {
  const template: string = DOCS_API_ERROR_MESSAGES[code];
  if (!detail) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = detail[name];
    return value === undefined ? match : String(value);
  });
}

/** The body for `code`, for the two places that cannot simply send a response. */
export function apiErrorBodyFor(code: DocsApiErrorCode, detail?: DocsApiErrorDetail): DocsApiErrorBody {
  return { error: code, message: renderMessage(code, detail), ...(detail ? { detail } : {}) };
}

/** `return apiError(res, 403, 'not_a_manager')` — the shape every refusal takes. */
export function apiError(
  res: ApiErrorResponder,
  status: number,
  code: DocsApiErrorCode,
  detail?: DocsApiErrorDetail,
): unknown {
  return res.status(status).json(apiErrorBodyFor(code, detail));
}

/**
 * The 403 body for a manager whose GitHub account cannot push.
 *
 * `reason` comes from `getDocsWriteAccess`, which answers with a code whenever
 * it knows why — no repository connected, or one of the four answers the write
 * probe can give — and `detail` carries what that code's sentence names (the
 * repository slug). An older caller that still passes a finished English
 * sentence keeps working: the viewer shows an unknown `error` as-is.
 */
export function writeAccessErrorBody(reason?: string, detail?: DocsApiErrorDetail): DocsApiErrorBody {
  const body: DocsApiErrorBody = isDocsApiErrorCode(reason)
    ? apiErrorBodyFor(reason, detail)
    : { error: reason ?? 'write_access_denied', message: reason ?? DOCS_API_ERROR_MESSAGES.write_access_denied };
  return { ...body, code: 'GITHUB_WRITE_FORBIDDEN' };
}
