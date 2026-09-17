import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import type { DocsApiErrorCode } from './api-errors';

/**
 * Whether a signed-in manager can actually commit to the workspace's repository.
 *
 * CHOIR's own manager role only says who may edit *in CHOIR*; pushing needs
 * write access on GitHub too, and GitHub reveals a missing write permission
 * only when the write is attempted (as a 404). The viewer asks this before
 * offering the Edit button, and the save endpoints ask again before doing any
 * work, so a manager is never invited into an edit that cannot be committed.
 */
export interface DocsWriteAccess {
  /** A GitHub account is linked for this user in this workspace. */
  connected: boolean;
  /** That account can push to the workspace's repository. */
  canPush: boolean;
  /** "owner/repo", when one is configured. */
  repo?: string;
  /**
   * Why not.
   *
   * A `DocsApiErrorCode` when CHOIR itself knows the answer, so the viewer can
   * say it in the reader's language — this is resolved at session time, which
   * is not necessarily a request that carried a locale. GitHub's own answers
   * come back as English sentences instead: they are assembled in
   * `services/github` out of a repository slug, an org OAuth policy URL or an
   * SSO prompt, and the viewer shows a `reason` it does not recognise verbatim.
   */
  reason?: string;
}

export async function getDocsWriteAccess(workspaceId: string, userId: string): Promise<DocsWriteAccess> {
  const repoInfo = await getGithubRepo(workspaceId);
  if (!repoInfo) {
    return {
      connected: false,
      canPush: false,
      reason: 'no_github_repo' satisfies DocsApiErrorCode,
    };
  }

  const access = await GithubService.getInstance().getRepoWriteAccess({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    workspaceId,
    userId,
  });

  return { ...access, repo: `${repoInfo.owner}/${repoInfo.repo}` };
}
