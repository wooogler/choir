/**
 * CHOIR's manager role says who may edit in CHOIR; pushing also needs write
 * access on GitHub. GitHub only reveals a missing write permission when the
 * write is attempted (as a 404), so the docs editor probes up front — these
 * tests pin how each GitHub answer is read.
 */

const getUserGithubToken = jest.fn(async () => 'gho_test' as string | null);

// octokit ships ESM-only and this suite never touches the real client: every
// test stubs getOctokit with its own fake.
jest.mock('octokit', () => ({ Octokit: class {} }));

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: class {
    getUserGithubToken = getUserGithubToken;
  },
}));

import { type DocsApiErrorCode, apiErrorBodyFor } from '../services/docs-editor/api-errors';
import GithubService, { type RepoWriteAccess } from '../services/github/github-service';

const service = GithubService.getInstance() as any;

const repoResponds = (data: unknown) => {
  service.getOctokit = jest.fn(async () => ({ rest: { repos: { get: jest.fn(async () => ({ data })) } } }));
};

const repoRejects = (status: number) => {
  service.getOctokit = jest.fn(async () => ({
    rest: {
      repos: {
        get: jest.fn(async () => {
          throw Object.assign(new Error(`HTTP ${status}`), { status });
        }),
      },
    },
  }));
};

const ask = (userId = 'U1') =>
  GithubService.getInstance().getRepoWriteAccess({
    owner: 'echo-lab',
    repo: 'assets',
    workspaceId: 'TCQV503UG',
    userId,
  });

describe('getRepoWriteAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    service.repoWriteAccessCache.clear();
    getUserGithubToken.mockResolvedValue('gho_test');
  });

  it('reports "not connected" when the user has no linked GitHub account', async () => {
    getUserGithubToken.mockResolvedValue(null);

    await expect(ask()).resolves.toEqual({
      connected: false,
      canPush: false,
      reason: expect.stringContaining('Connect your GitHub account'),
      reasonCode: 'github_no_token',
      params: { repo: 'echo-lab/assets' },
    });
  });

  it('blocks a read-only collaborator and says how to fix it', async () => {
    repoResponds({ permissions: { pull: true, push: false, admin: false } });

    const access = await ask();
    expect(access.canPush).toBe(false);
    expect(access.reason).toContain('read-only access to echo-lab/assets');
    expect(access.reason).toContain('Write access');
    expect(access.reasonCode).toBe('github_repo_read_only');
  });

  it('allows push, maintain, and admin', async () => {
    repoResponds({ permissions: { pull: true, push: true } });
    await expect(ask('U-push')).resolves.toEqual({ connected: true, canPush: true });

    repoResponds({ permissions: { pull: true, maintain: true } });
    await expect(ask('U-maintain')).resolves.toEqual({ connected: true, canPush: true });

    repoResponds({ permissions: { pull: true, admin: true } });
    await expect(ask('U-admin')).resolves.toEqual({ connected: true, canPush: true });
  });

  it('blocks an archived repository even for an admin', async () => {
    repoResponds({ archived: true, permissions: { admin: true, push: true } });

    const access = await ask();
    expect(access.canPush).toBe(false);
    expect(access.reason).toContain('archived');
    expect(access.reasonCode).toBe('github_repo_is_archived');
  });

  it('reads a 404 as "your account cannot see this repository"', async () => {
    repoRejects(404);

    const access = await ask();
    expect(access.canPush).toBe(false);
    expect(access.reason).toContain('cannot see echo-lab/assets');
    expect(access.reasonCode).toBe('github_repo_not_visible');
  });

  // The English above is what the log and an old client keep seeing; the code
  // beside it is what lets the viewer say the same thing in Korean. Both halves
  // have to stay true, so pin them together: every refusal carries a code whose
  // catalog English, with the slug filled in, is the sentence itself.
  it('says each refusal twice — as English, and as a code the viewer can translate', async () => {
    const refusals: RepoWriteAccess[] = [];

    getUserGithubToken.mockResolvedValue(null);
    refusals.push(await ask('U-none'));
    getUserGithubToken.mockResolvedValue('gho_test');

    repoResponds({ archived: true, permissions: { admin: true } });
    refusals.push(await ask('U-archived'));

    repoResponds({ permissions: { pull: true } });
    refusals.push(await ask('U-read'));

    repoRejects(404);
    refusals.push(await ask('U-hidden'));

    expect(refusals.map((r) => r.reasonCode)).toEqual([
      'github_no_token',
      'github_repo_is_archived',
      'github_repo_read_only',
      'github_repo_not_visible',
    ]);

    for (const refusal of refusals) {
      expect(refusal.canPush).toBe(false);
      expect(refusal.params).toEqual({ repo: 'echo-lab/assets' });
      const body = apiErrorBodyFor(refusal.reasonCode as DocsApiErrorCode, refusal.params);
      expect([refusal.reasonCode, body.message]).toEqual([refusal.reasonCode, refusal.reason]);
    }
  });

  it('fails open on an unexpected GitHub error rather than locking managers out', async () => {
    repoRejects(500);

    await expect(ask()).resolves.toEqual({ connected: true, canPush: true });
  });

  it('caches the answer so a page load costs at most one API call', async () => {
    const get = jest.fn(async () => ({ data: { permissions: { push: true } } }));
    service.getOctokit = jest.fn(async () => ({ rest: { repos: { get } } }));

    await ask();
    await ask();

    expect(get).toHaveBeenCalledTimes(1);
  });
});
