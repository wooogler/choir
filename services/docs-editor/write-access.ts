import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';

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
  /** Why not, phrased for the person who has to fix it. */
  reason?: string;
}

export async function getDocsWriteAccess(workspaceId: string, userId: string): Promise<DocsWriteAccess> {
  const repoInfo = await getGithubRepo(workspaceId);
  if (!repoInfo) {
    return {
      connected: false,
      canPush: false,
      reason: 'No GitHub repository is connected to this workspace yet.',
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
