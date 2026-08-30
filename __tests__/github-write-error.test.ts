import { ErrorCodes, GitHubError } from '../services/common/error-handler';
import { classifyGitHubWriteFailure } from '../services/github/write-error';

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
    expect(failure.statusCode).toBe(403);
    expect(failure.message).toContain('no push access to echo-lab/assets');
    expect(failure.message).toContain('06_Conferences.md');
  });

  it('reads a 404 on a read as a missing repo/branch/path', () => {
    const failure = classifyGitHubWriteFailure(httpError(404, 'Not Found', 'GET'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_FILE_NOT_FOUND);
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
    expect(failure.message).toContain('organizations/echo-lab/settings/oauth_application_policy');
  });

  it('points at SSO authorization when SAML blocks the write', () => {
    const failure = classifyGitHubWriteFailure(
      httpError(403, 'Resource protected by organization SAML enforcement. You must grant your OAuth token access'),
      ctx,
    );

    expect(failure.code).toBe(ErrorCodes.GITHUB_WRITE_FORBIDDEN);
    expect(failure.message).toContain('single sign-on');
  });

  it('separates a secondary rate limit from a permission failure', () => {
    const failure = classifyGitHubWriteFailure(httpError(403, 'You have exceeded a secondary rate limit'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_RATE_LIMITED);
    expect(failure.statusCode).toBe(429);
  });

  it('surfaces expired credentials as 403, not 401 (401 means "no CHOIR session")', () => {
    const failure = classifyGitHubWriteFailure(httpError(401, 'Bad credentials'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_AUTH_FAILED);
    expect(failure.statusCode).toBe(403);
    expect(failure.message).toContain('Reconnect your GitHub account');
  });

  it('treats 409 and 422 as conflicts the manager can retry', () => {
    expect(classifyGitHubWriteFailure(httpError(409, 'Conflict'), ctx).code).toBe(ErrorCodes.GITHUB_CONFLICT);

    const protectedBranch = classifyGitHubWriteFailure(
      httpError(422, 'Changes must be made through a pull request'),
      ctx,
    );
    expect(protectedBranch.statusCode).toBe(409);
    expect(protectedBranch.message).toContain('protected branch');
    expect(protectedBranch.message).toContain('pull request');
  });

  it('maps GitHub outages to a bad-gateway', () => {
    const failure = classifyGitHubWriteFailure(httpError(502, 'Bad gateway'), ctx);

    expect(failure.code).toBe(ErrorCodes.GITHUB_UNAVAILABLE);
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

    expect(failure.code).toBe(ErrorCodes.GITHUB_UPDATE_FAILED);
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
