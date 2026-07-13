import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import { addCommitsForDir, blameLineCommits } from 'services/workspace/git-mirror';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

const CONTEXT_DIR = '.choir/context';

/**
 * Line-level provenance for a document: maps each current line number to the
 * id of the provenance record whose commit last changed that line.
 *
 * line → (git blame) → commit SHA → (git log on `.choir/context/<doc>/`) → record.
 * Lines changed by non-CHOIR commits (no record) are simply omitted. Requires the
 * local git clone; returns an empty map if it isn't available.
 */
export async function getLineProvenance(params: {
  workspaceId: string;
  docPath: string;
  userId?: string;
}): Promise<{ lines: Record<number, string> }> {
  const { workspaceId, docPath, userId } = params;
  const repo = await getGithubRepo(workspaceId);
  if (!repo) return { lines: {} };

  const mirror = WorkspaceMirrorService.getInstance();
  // Refresh the clone so blame reflects the latest commits (incl. CHOIR's own).
  const remoteUrl = await GithubService.getInstance().getAuthenticatedRemoteUrl({
    owner: repo.owner,
    repo: repo.repo,
    workspaceId,
    userId,
  });
  await mirror.ensureGitClone({ workspaceId, remoteUrl, branch: repo.branch });

  const gitRoot = mirror.getGitRepoRoot(workspaceId);
  const normalized = docPath.replace(/^\/+/, '');
  const [lineShas, addCommits] = await Promise.all([
    blameLineCommits(gitRoot, normalized),
    addCommitsForDir(gitRoot, `${CONTEXT_DIR}/${normalized}`),
  ]);

  // Invert "record file → commit" into "commit → record id" (basename).
  const recordBySha = new Map<string, string>();
  for (const [filePath, sha] of addCommits) {
    const id = filePath.split('/').pop();
    if (id) recordBySha.set(sha, id);
  }

  const lines: Record<number, string> = {};
  for (const [lineNo, sha] of lineShas) {
    const recordId = recordBySha.get(sha);
    if (recordId) lines[lineNo] = recordId;
  }
  return { lines };
}
