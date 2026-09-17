import { ErrorCodes, GitHubError } from '../services/common/error-handler';
import { apiErrorBodyFor } from '../services/docs-editor/api-errors';
import {
  classifyGitHubWriteFailure,
  docsApiCodeForGitHubError,
  toGitHubWriteError,
} from '../services/github/write-error';
import { describeError } from '../services/i18n/describe-error';
import { createT } from '../src/i18n';

const ctx = { owner: 'echo-lab', repo: 'assets', path: '06_Conferences.md', branch: 'master', action: 'update' };

/** Minimal stand-in for an Octokit HttpError. */
const httpError = (status: number, message: string, method = 'PUT') =>
  Object.assign(new Error(message), { status, request: { method } });

describe('classifyGitHubWriteFailure', () => {
  it('reads a 404 on the write itself as a missing push permission', () => {
    const failure = classifyGitHubWriteFailure(
      httpError(404, 'Not Found - https://docs.github.com/rest/repos/contents#create-or-update-file-contents'),
      ctx,
    );

    expect(failure.code).toBe(ErrorCodes.GITHUB_WRITE_FORBIDDEN);
    expect(failure.catalogCode).toBe('github.noPushAccess');
    expect(failure.statusCode).toBe(403);
    expect(failure.message).toContain('no push access to echo-lab/assets');
    expect(failure.message).toContain('06_Conferences.md');
  });

  it('reads a 404 on a read as a missing repo/branch/path', () => {
    const failure = classifyGitHubWriteFailure(httpError(404, 'Not Found', 'GET'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_FILE_NOT_FOUND);
    expect(failure.catalogCode).toBe('github.targetNotFound');
    expect(failure.statusCode).toBe(404);
    expect(failure.message).toContain('could not find');
  });

  it('names the org OAuth policy when access restrictions block the write', () => {
    const failure = classifyGitHubWriteFailure(
      httpError(
        403,
        'Although you appear to have the correct authorization credentials, the `echo-lab` organization has enabled OAuth App access restrictions',
      ),
      ctx,
    );

    expect(failure.code).toBe(ErrorCodes.GITHUB_WRITE_FORBIDDEN);
    expect(failure.catalogCode).toBe('github.oauthAppRestricted');
    // The URL travels as a param, so a translation never has to carry it.
    expect(failure.params?.url).toBe('https://github.com/organizations/echo-lab/settings/oauth_application_policy');
    expect(failure.message).toContain('organizations/echo-lab/settings/oauth_application_policy');
  });

  it('points at SSO authorization when SAML blocks the write', () => {
    const failure = classifyGitHubWriteFailure(
      httpError(403, 'Resource protected by organization SAML enforcement. You must grant your OAuth token access'),
      ctx,
    );

    expect(failure.code).toBe(ErrorCodes.GITHUB_WRITE_FORBIDDEN);
    expect(failure.catalogCode).toBe('github.ssoRequired');
    expect(failure.message).toContain('single sign-on');
  });

  it('separates a secondary rate limit from a permission failure', () => {
    const failure = classifyGitHubWriteFailure(httpError(403, 'You have exceeded a secondary rate limit'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_RATE_LIMITED);
    expect(failure.catalogCode).toBe('github.rateLimited');
    expect(failure.statusCode).toBe(429);
  });

  it('surfaces expired credentials as 403, not 401 (401 means "no CHOIR session")', () => {
    const failure = classifyGitHubWriteFailure(httpError(401, 'Bad credentials'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_AUTH_FAILED);
    expect(failure.catalogCode).toBe('github.credentialsRejected');
    expect(failure.statusCode).toBe(403);
    expect(failure.message).toContain('Reconnect your GitHub account');
  });

  it('treats 409 and 422 as conflicts the manager can retry', () => {
    expect(classifyGitHubWriteFailure(httpError(409, 'Conflict'), ctx).code).toBe(ErrorCodes.GITHUB_CONFLICT);

    const protectedBranch = classifyGitHubWriteFailure(
      httpError(422, 'Changes must be made through a pull request'),
      ctx,
    );
    expect(protectedBranch.catalogCode).toBe('github.branchProtectedDetail');
    expect(protectedBranch.statusCode).toBe(409);
    expect(protectedBranch.message).toContain('protected branch');
    expect(protectedBranch.message).toContain('pull request');
  });

  it('maps GitHub outages to a bad-gateway', () => {
    const failure = classifyGitHubWriteFailure(httpError(502, 'Bad gateway'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_UNAVAILABLE);
    expect(failure.catalogCode).toBe('github.unavailable');
    expect(failure.statusCode).toBe(502);
  });

  it('passes our own GitHubError through untouched', () => {
    const original = new GitHubError('Concurrent modification of docs/guide.md while committing; aborting', {
      code: ErrorCodes.GITHUB_UPDATE_FAILED,
      statusCode: 409,
    });

    expect(classifyGitHubWriteFailure(original, ctx)).toEqual({
      code: ErrorCodes.GITHUB_UPDATE_FAILED,
      statusCode: 409,
      message: original.message,
    });
  });

  it('falls back to the raw detail for an unrecognised failure', () => {
    const failure = classifyGitHubWriteFailure(new Error('socket hang up'), ctx);

    // Deliberately uncoded: nobody can be told what to do about a socket hang up.
    expect(failure.code).toBe(ErrorCodes.GITHUB_UPDATE_FAILED);
    expect(failure.catalogCode).toBeUndefined();
    expect(failure.statusCode).toBe(500);
    expect(failure.message).toContain('socket hang up');
  });

  it('truncates a runaway GitHub message instead of echoing it whole', () => {
    const failure = classifyGitHubWriteFailure(httpError(500, 'x'.repeat(1000)), {
      ...ctx,
      action: 'commit',
    });

    expect(failure.message.length).toBeLessThan(500);
  });
});

/**
 * The point of the codes: an English reader must see exactly the sentence the
 * classifier wrote, whether it reaches them through Slack (`describeError`) or
 * through the docs API (`apiErrorBodyFor`). Both rebuild it from a catalog
 * entry and the params, so any drift between the three copies of that English
 * shows up here rather than on somebody's screen.
 */
describe('the same sentence on every surface', () => {
  const en = createT('en');
  const ko = createT('ko');

  // One case per classified branch, so a new branch without a code is noticed.
  const cases: Array<[string, unknown, typeof ctx]> = [
    ['401', httpError(401, 'Bad credentials'), ctx],
    ['403 rate limit', httpError(403, 'You have exceeded a secondary rate limit'), ctx],
    ['403 OAuth App access restrictions', httpError(403, 'OAuth App access restrictions'), ctx],
    ['403 SAML', httpError(403, 'organization SAML enforcement'), ctx],
    ['403 archived', httpError(403, 'Repository was archived so is read-only'), ctx],
    ['403 with a detail', httpError(403, 'Resource not accessible'), ctx],
    ['403 without a detail', httpError(403, ''), ctx],
    ['404 on the write', httpError(404, 'Not Found'), ctx],
    ['404 on a read', httpError(404, 'Not Found', 'GET'), ctx],
    ['409', httpError(409, ''), ctx],
    ['422 with a detail', httpError(422, 'Changes must be made through a pull request'), ctx],
    ['422 without a detail', httpError(422, ''), ctx],
    ['429', httpError(429, ''), ctx],
    ['500', httpError(500, ''), { ...ctx, action: 'commit' }],
  ];

  it.each(cases)('%s reaches Slack in English unchanged', (_name, error, context) => {
    const failure = classifyGitHubWriteFailure(error, context);
    expect(failure.catalogCode).toBeDefined();
    expect(describeError(en, toGitHubWriteError(error, context))).toBe(failure.message);
  });

  it.each(cases)('%s reaches the docs API in English unchanged', (_name, error, context) => {
    const failure = classifyGitHubWriteFailure(error, context);
    const thrown = toGitHubWriteError(error, context);
    const apiCode = docsApiCodeForGitHubError(thrown.code);

    expect(apiCode).toBeDefined();
    // `error` is the code the viewer translates; `message` is the English it
    // stands for, which is what a `curl` and the server log still show.
    const body = apiErrorBodyFor(apiCode as never, thrown.params);
    expect(body.error).toBe(apiCode);
    expect(body.message).toBe(failure.message);
  });

  it.each(cases)('%s says something different in Korean', (_name, error, context) => {
    const thrown = toGitHubWriteError(error, context);
    expect(describeError(ko, thrown)).not.toBe(thrown.message);
  });

  it('keeps the ErrorCodes classification on metadata, where the log wants it', () => {
    const thrown = toGitHubWriteError(httpError(401, 'Bad credentials'), ctx);

    expect(thrown.code).toBe('github.credentialsRejected');
    expect(thrown.metadata.errorCode).toBe(ErrorCodes.GITHUB_AUTH_FAILED);
  });

  it('leaves an unclassifiable failure as its English message', () => {
    const thrown = toGitHubWriteError(new Error('socket hang up'), ctx);

    expect(docsApiCodeForGitHubError(thrown.code)).toBeUndefined();
    expect(describeError(en, thrown)).toBe(thrown.message);
  });

  it('carries the fillers of a pass-through error rather than dropping them', () => {
    const original = new GitHubError('Concurrent modification of docs/guide.md while committing; aborting', {
      code: 'github.concurrentModification',
      statusCode: 409,
      params: { path: 'docs/guide.md' },
    });

    expect(describeError(ko, toGitHubWriteError(original, ctx))).toContain('docs/guide.md');
  });
});
