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

import GithubService from '../services/github/github-service';

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
    });
  });

  it('blocks a read-only collaborator and says how to fix it', async () => {
    repoResponds({ permissions: { pull: true, push: false, admin: false } });

    const access = await ask();
    expect(access.canPush).toBe(false);
    expect(access.reason).toContain('read-only access to echo-lab/assets');
    expect(access.reason).toContain('Write access');
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
  });

  it('reads a 404 as "your account cannot see this repository"', async () => {
    repoRejects(404);

    const access = await ask();
    expect(access.canPush).toBe(false);
    expect(access.reason).toContain('cannot see echo-lab/assets');
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
