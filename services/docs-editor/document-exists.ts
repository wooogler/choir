import fs from 'node:fs';
import path from 'node:path';
import { GithubService } from 'services/github';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

/** The workspace repository a path is checked against. */
export interface RepoRef {
  owner: string;
  repo: string;
  branch?: string;
}

/**
 * Whether anything already lives at a repository path.
 *
 * Shared by "New document" and by rename, which must refuse the same occupied
 * path for the same reason: landing on one would be a silent, unreviewed
 * replacement of a document somebody else wrote.
 *
 * The mirror is a cache, not the repository. A fresh install has not synced
 * yet, a push webhook can be missed, and a document committed to GitHub minutes
 * ago may not be on disk at all — so the only honest "is this path free?" comes
 * from GitHub, and the local look is only there to answer the common case
 * without a round-trip.
 *
 * Check-then-commit is not atomic: two managers writing the same path at the
 * same moment can still collide. That is accepted — these routes are
 * manager-only and the loser's content survives in the commit history either
 * way.
 */
export async function documentExists(params: {
  workspaceId: string;
  /** Whose GitHub token to look with; omitted for a read-only preflight. */
  userId?: string;
  filePath: string;
  repo: RepoRef;
}): Promise<boolean> {
  const mirror = WorkspaceMirrorService.getInstance();
  const repoRoot = mirror.getRepoRoot(params.workspaceId);

  // `fs.existsSync` before `readMirrorFile`, deliberately: the mirror read only
  // forgives ENOENT, so a directory (or an unreadable file) named `foo.md` would
  // throw EISDIR out of here and the route would answer 500 for what is plainly
  // an occupied path.
  if (fs.existsSync(path.join(repoRoot, params.filePath))) return true;
  if (await mirrorHolds(params.workspaceId, params.filePath)) return true;

  return (
    (await GithubService.getInstance().getFile({
      owner: params.repo.owner,
      repo: params.repo.repo,
      path: params.filePath,
      branch: params.repo.branch,
      workspaceId: params.workspaceId,
      userId: params.userId,
    })) !== null
  );
}

/**
 * Whether the mirror holds anything at this path.
 *
 * A read that fails for any reason other than "not there" counts as occupied:
 * a path CHOIR cannot look at is not a path it should commit over.
 */
async function mirrorHolds(workspaceId: string, filePath: string): Promise<boolean> {
  try {
    return (await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, filePath)) !== null;
  } catch {
    return true;
  }
}
