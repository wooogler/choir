import type { ErrorCode } from 'services/common/choir-error';
import { ErrorCodes, type ErrorParams, GitHubError } from 'services/common/error-handler';
import type { DocsApiErrorCode } from 'services/docs-editor/api-errors';

/**
 * Turns a failed GitHub write into a GitHubError that says what actually went
 * wrong.
 *
 * The Contents and Git Data APIs answer a missing write permission with 404
 * rather than 403 — GitHub hides the repository instead of admitting the
 * permission gap — so callers that collapsed every failure into a generic
 * "Failed to update file" left managers with nothing to act on. Every write
 * path in github-service.ts routes its catch through here.
 */

/** The parts of an Octokit HttpError this mapping reads. */
interface HttpErrorLike {
  status?: number;
  message?: string;
  request?: { method?: string };
}

export interface GitHubWriteContext {
  owner: string;
  repo: string;
  /** Verb used in the message, e.g. 'update', 'commit', 'upload'. */
  action: string;
  branch?: string;
  path?: string;
}

export interface GitHubFailure {
  code: string;
  /** Status to surface from our own HTTP API (not GitHub's status). */
  statusCode: number;
  message: string;
  /**
   * The catalog entry `message` was built from, when the failure is one a
   * reader can act on. `code` stays GitHub's own `ErrorCodes.*` vocabulary —
   * logs and metrics group by it — while this is what lets Slack and the docs
   * viewer rebuild the same sentence in the reader's language.
   */
  catalogCode?: ErrorCode;
  /** The holes in that entry, in the order the English fills them. */
  params?: ErrorParams;
}

/**
 * The docs API's name for each write failure.
 *
 * Two vocabularies rather than one because they cross different boundaries:
 * `ErrorCode` is dotted and lives in the Slack catalog, `DocsApiErrorCode` is
 * snake_case and is what `web/` compiles against. This map is the only place
 * they meet.
 */
const DOCS_API_CODE: Partial<Record<ErrorCode, DocsApiErrorCode>> = {
  'github.credentialsRejected': 'github_credentials_rejected',
  'github.rateLimited': 'github_rate_limited',
  'github.oauthAppRestricted': 'github_oauth_app_restricted',
  'github.ssoRequired': 'github_sso_required',
  'github.repoArchived': 'github_repo_archived',
  'github.writeForbidden': 'github_write_forbidden',
  'github.writeForbiddenDetail': 'github_write_forbidden_detail',
  'github.noPushAccess': 'github_no_push_access',
  'github.targetNotFound': 'github_target_not_found',
  'github.branchMoved': 'github_branch_moved',
  'github.branchProtected': 'github_branch_protected',
  'github.branchProtectedDetail': 'github_branch_protected_detail',
  'github.unavailable': 'github_unavailable',
};

/**
 * The docs API code for a thrown error's `code`, or undefined when the error is
 * not one of the classified write failures (in which case its English message
 * is still the most honest thing to send).
 */
export function docsApiCodeForGitHubError(code: string | undefined): DocsApiErrorCode | undefined {
  return code ? DOCS_API_CODE[code as ErrorCode] : undefined;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_DETAIL_LENGTH = 300;

function detailOf(error: HttpErrorLike): string {
  const raw = (error.message || '').trim();
  return raw.length > MAX_DETAIL_LENGTH ? `${raw.slice(0, MAX_DETAIL_LENGTH)}…` : raw;
}

function describeTarget(ctx: GitHubWriteContext): string {
  const path = ctx.path ? ` (${ctx.path})` : '';
  const branch = ctx.branch ? ` on ${ctx.branch}` : '';
  return `${ctx.owner}/${ctx.repo}${path}${branch}`;
}

function withDetail(sentence: string, detail: string): string {
  return detail ? `${sentence} GitHub said: ${detail}` : sentence;
}

/**
 * Classifies an error thrown while writing to GitHub. Exported separately from
 * `toGitHubWriteError` so it can be unit tested without constructing errors.
 */
export function classifyGitHubWriteFailure(error: unknown, ctx: GitHubWriteContext): GitHubFailure {
  // Errors we raised ourselves (concurrent modification, invalid file data)
  // already carry a precise message and code — don't re-describe them.
  if (error instanceof GitHubError) {
    return {
      code: error.code,
      statusCode: error.statusCode ?? 500,
      message: error.message,
      // A throw that already named a catalog entry (`github.concurrentModification`)
      // carries the fillers for it; dropping them here would leave the reader
      // with "{path}" in the middle of an otherwise Korean sentence.
      ...(error.params ? { params: error.params } : {}),
    };
  }

  const httpError = (error ?? {}) as HttpErrorLike;
  const status = typeof httpError.status === 'number' ? httpError.status : undefined;
  const detail = detailOf(httpError);
  const target = describeTarget(ctx);
  const repo = `${ctx.owner}/${ctx.repo}`;
  // Every classified sentence is built from these, so a translation can name the
  // same things without re-parsing the English.
  const base = { action: ctx.action, target, repo, owner: ctx.owner };
  // A 404 means very different things for the SHA lookup and for the write
  // itself, so the failing request's method decides how to read it.
  const isWrite = WRITE_METHODS.has((httpError.request?.method || '').toUpperCase());

  if (status === 401) {
    return {
      code: ErrorCodes.GITHUB_AUTH_FAILED,
      // Not 401: our own 401 means "no CHOIR session", which is not the problem.
      statusCode: 403,
      message: `GitHub rejected the stored credentials while trying to ${ctx.action} ${target}. Reconnect your GitHub account from the CHOIR App Home and try again.`,
      catalogCode: 'github.credentialsRejected',
      params: base,
    };
  }

  if (status === 403 && /rate limit|secondary rate|abuse detection/i.test(detail)) {
    return {
      code: ErrorCodes.GITHUB_RATE_LIMITED,
      statusCode: 429,
      message: `GitHub rate-limited the request to ${ctx.action} ${target}. Wait a moment and try again.`,
      catalogCode: 'github.rateLimited',
      params: base,
    };
  }

  if (status === 403 && /OAuth App access restrictions/i.test(detail)) {
    const url = `https://github.com/organizations/${ctx.owner}/settings/oauth_application_policy`;
    return {
      code: ErrorCodes.GITHUB_WRITE_FORBIDDEN,
      statusCode: 403,
      message: `The ${ctx.owner} organization has not approved CHOIR's GitHub OAuth app, so it cannot ${ctx.action} ${target}. An organization owner must approve it at ${url}.`,
      catalogCode: 'github.oauthAppRestricted',
      params: { ...base, url },
    };
  }

  if (status === 403 && /SAML|single sign-on|single sign on/i.test(detail)) {
    return {
      code: ErrorCodes.GITHUB_WRITE_FORBIDDEN,
      statusCode: 403,
      message: `Your GitHub authorization is not enabled for ${ctx.owner}'s SAML single sign-on, so CHOIR cannot ${ctx.action} ${target}. Authorize it under your GitHub account's "Authorized OAuth Apps" settings, then retry.`,
      catalogCode: 'github.ssoRequired',
      params: base,
    };
  }

  if (status === 403 && /archived|read-only/i.test(detail)) {
    return {
      code: ErrorCodes.GITHUB_WRITE_FORBIDDEN,
      statusCode: 403,
      message: `${repo} is archived or read-only, so CHOIR cannot ${ctx.action} ${target}.`,
      catalogCode: 'github.repoArchived',
      params: base,
    };
  }

  if (status === 403) {
    return {
      code: ErrorCodes.GITHUB_WRITE_FORBIDDEN,
      statusCode: 403,
      message: withDetail(`GitHub refused to let the connected account ${ctx.action} ${target}.`, detail),
      catalogCode: detail ? 'github.writeForbiddenDetail' : 'github.writeForbidden',
      params: detail ? { ...base, detail } : base,
    };
  }

  if (status === 404 && isWrite) {
    return {
      code: ErrorCodes.GITHUB_WRITE_FORBIDDEN,
      statusCode: 403,
      message: `GitHub answered 404 when CHOIR tried to ${ctx.action} ${target}. GitHub reports a missing write permission as 404, so the connected GitHub account almost certainly has no push access to ${repo}. Ask a repository admin to grant Write access, or reconnect GitHub from the CHOIR App Home with an account that has it.`,
      catalogCode: 'github.noPushAccess',
      params: base,
    };
  }

  if (status === 404) {
    return {
      code: ErrorCodes.GITHUB_FILE_NOT_FOUND,
      statusCode: 404,
      message: `GitHub could not find ${target}. Check the repository, branch, and file path configured for this workspace.`,
      catalogCode: 'github.targetNotFound',
      params: base,
    };
  }

  if (status === 409) {
    return {
      code: ErrorCodes.GITHUB_CONFLICT,
      statusCode: 409,
      message: `The branch moved while CHOIR was writing ${target}, so the ${ctx.action} was rejected as a conflict. Reload the document and re-apply your change.`,
      catalogCode: 'github.branchMoved',
      params: base,
    };
  }

  if (status === 422) {
    return {
      code: ErrorCodes.GITHUB_CONFLICT,
      statusCode: 409,
      message: withDetail(
        `GitHub rejected the ${ctx.action} of ${target}. A protected branch that requires a pull request is the usual cause.`,
        detail,
      ),
      catalogCode: detail ? 'github.branchProtectedDetail' : 'github.branchProtected',
      params: detail ? { ...base, detail } : base,
    };
  }

  if (status === 429) {
    return {
      code: ErrorCodes.GITHUB_RATE_LIMITED,
      statusCode: 429,
      message: `GitHub rate-limited the request to ${ctx.action} ${target}. Wait a moment and try again.`,
      catalogCode: 'github.rateLimited',
      params: base,
    };
  }

  if (status !== undefined && status >= 500) {
    return {
      code: ErrorCodes.GITHUB_UNAVAILABLE,
      statusCode: 502,
      message: `GitHub is unavailable (HTTP ${status}), so the ${ctx.action} of ${target} did not go through. Try again shortly.`,
      catalogCode: 'github.unavailable',
      params: { ...base, status },
    };
  }

  // Deliberately uncoded: "Failed to update x. GitHub said: socket hang up" is
  // not a failure anyone can be told what to do about, and a translated shrug
  // would be worse than GitHub's own words.
  return {
    code: ErrorCodes.GITHUB_UPDATE_FAILED,
    statusCode: 500,
    message: withDetail(`Failed to ${ctx.action} ${target}.`, detail),
  };
}

/**
 * Convenience wrapper: classify, then wrap in a throwable GitHubError.
 *
 * `code` becomes the catalog code when there is one, which is what `describeError`
 * looks up; the `ErrorCodes.*` classification stays on `metadata.errorCode` for
 * the log, where it was the only audience anyway.
 */
export function toGitHubWriteError(error: unknown, ctx: GitHubWriteContext): GitHubError {
  const failure = classifyGitHubWriteFailure(error, ctx);
  return new GitHubError(failure.message, {
    code: failure.catalogCode ?? failure.code,
    statusCode: failure.statusCode,
    params: failure.params,
    metadata: {
      owner: ctx.owner,
      repo: ctx.repo,
      path: ctx.path,
      branch: ctx.branch,
      errorCode: failure.code,
      githubStatus: (error as HttpErrorLike)?.status,
    },
  });
}
