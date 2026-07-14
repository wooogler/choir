import fs from 'node:fs';
import path from 'node:path';
import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import { addCommitsForDir, blameLineCommits } from 'services/workspace/git-mirror';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

const CONTEXT_DIR = '.choir/context';

// Blame is requested per line-gutter render, so avoid a synchronous network
// `git fetch` on every request: refresh the clone at most once per TTL per
// workspace (the first request still clones/fetches).
const cloneRefreshedAt = new Map<string, number>();
const BLAME_CLONE_TTL_MS = 30_000;

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
}): Promise<{ lines: Record<number, string>; content?: string }> {
  const { workspaceId, docPath, userId } = params;
  const repo = await getGithubRepo(workspaceId);
  if (!repo) return { lines: {} };

  const mirror = WorkspaceMirrorService.getInstance();
  // Refresh the clone so blame reflects the latest commits (incl. CHOIR's own),
  // but throttle the network fetch so a burst of gutter renders doesn't fetch
  // every time.
  const lastRefresh = cloneRefreshedAt.get(workspaceId);
  if (!lastRefresh || Date.now() - lastRefresh > BLAME_CLONE_TTL_MS) {
    const remoteUrl = await GithubService.getInstance().getAuthenticatedRemoteUrl({
      owner: repo.owner,
      repo: repo.repo,
      workspaceId,
      userId,
    });
    const ok = await mirror.ensureGitClone({ workspaceId, remoteUrl, branch: repo.branch });
    if (ok) cloneRefreshedAt.set(workspaceId, Date.now());
  }

  const gitRoot = mirror.getGitRepoRoot(workspaceId);
  const normalized = docPath.replace(/^\/+/, '');

  // Read the document from the SAME clone snapshot blame runs against, so the
  // returned content and the line→record map line up exactly. The API-materialized
  // mirror the viewer would otherwise render can diverge from this snapshot, which
  // made markers attach to the wrong lines.
  let content: string | undefined;
  try {
    content = await fs.promises.readFile(path.join(gitRoot, normalized), 'utf-8');
  } catch {
    content = undefined;
  }

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
  return { lines, content };
}
