import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import type { DocsApiErrorCode, DocsApiErrorDetail } from './api-errors';

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
   * A `DocsApiErrorCode` whenever CHOIR knows the answer — no repository
   * connected, or any of the four the write probe can give — so the viewer can
   * say it in the reader's language; this is resolved at session time, which is
   * not necessarily a request that carried a locale. Anything else arrives as
   * an English sentence, and the viewer shows a `reason` it does not recognise
   * verbatim.
   */
  reason?: string;
  /** Fills that code's `{name}` holes — the repository slug, in practice. */
  detail?: DocsApiErrorDetail;
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

  // The probe keeps its English `reason` for the log; what goes out is the code
  // it was written from, so the browser can say the same thing in the reader's
  // language. A probe answer with no code (there is none today) still travels
  // as its sentence rather than as nothing.
  return {
    connected: access.connected,
    canPush: access.canPush,
    repo: `${repoInfo.owner}/${repoInfo.repo}`,
    ...(access.reasonCode
      ? { reason: access.reasonCode, ...(access.params ? { detail: access.params } : {}) }
      : access.reason
        ? { reason: access.reason }
        : {}),
  };
}
