import fs from 'node:fs';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { removeDocState } from 'services/google/gdocs-state';
import { retireManualCards } from 'services/google/manual-apply';
import { retireReviewCards } from 'services/google/review-cards';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { PathMapService } from 'services/workspace/path-map-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { pickNextDocument } from './next-document';

export interface DeleteDocumentResult {
  commitSha: string;
  /** A surviving document to send the viewer to, or null if none is left. */
  nextFilePath: string | null;
}

/**
 * Deletes a markdown document: removes it from GitHub, then unwinds every piece
 * of local state that was keyed to it.
 *
 * The commit is tagged `[choir-auto]`, which makes the GitHub push webhook skip
 * it, so nothing else will ever reconcile the mirror — every cleanup below has
 * to happen here. A document that is only unlinked from disk keeps answering
 * questions from the QMD index, and a replica left mapped keeps being polled for
 * drift against a document that no longer exists.
 *
 * The encrypted provenance under `.choir/context/<path>/` is deliberately kept.
 * It is the record of why the document changed while it existed, git preserves
 * it either way, and removing it would be the one part of this operation that
 * destroys history rather than moving it into the past.
 */
export async function deleteDocument(params: {
  workspaceId: string;
  userId: string;
  filePath: string;
  commitMessage?: string;
  /** Lets a pending review card be retired with an explanation. */
  slackClient?: WebClient;
}): Promise<DeleteDocumentResult> {
  const { workspaceId, filePath, userId } = params;

  const repoInfo = await getGithubRepo(workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const mirror = WorkspaceMirrorService.getInstance();
  const store = new WorkspaceStore();

  // Commit BEFORE touching anything local, for the reason save-document.ts
  // spells out: a rejected push must not leave CHOIR serving a repository state
  // that GitHub does not have.
  const { commitSha } = await GithubService.getInstance().commitFilesWithContext({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    message: params.commitMessage?.trim() || `Delete ${filePath}`,
    files: [],
    deletions: [filePath],
    workspaceId,
    userId,
  });

  // A replica of a document that no longer exists is worse than a stale row: the
  // poller keeps comparing against it, and a manager approving an open review
  // card would commit the deleted path straight back into the repository. Same
  // order the unlink route uses — retire the cards first, while the mapping they
  // refer to still exists.
  if (await store.getGoogleDocMapping(workspaceId, filePath)) {
    try {
      await retireReviewCards({
        workspaceId,
        githubPath: filePath,
        reason: 'This document was deleted, so the pending edit was dropped.',
        client: params.slackClient,
      });
      await retireManualCards({
        workspaceId,
        githubPath: filePath,
        reason: 'This document was deleted, so there is nothing left to apply in Google Docs.',
        client: params.slackClient,
      });
      await store.removeGoogleDocMapping(workspaceId, filePath);
      await removeDocState(workspaceId, filePath);
    } catch (error) {
      Logger.warn('deleteDocument: failed to unlink the Google Docs replica', error as Error);
    }
  }

  await mirror.removeMarkdownFile(workspaceId, filePath);

  const surviving = await listMarkdownPaths(mirror.getRepoRoot(workspaceId));

  // PathMapService is add-only, so the entry goes by re-saving what is left.
  try {
    await PathMapService.getInstance().save(workspaceId, surviving);
  } catch (error) {
    Logger.warn('deleteDocument: failed to rewrite the path map', error as Error);
  }

  try {
    const vectorStore = VectorStoreService.getInstance();
    const remaining = vectorStore.getAllMarkdownFiles(workspaceId).filter((file) => file.path !== filePath);
    vectorStore.setLoadedMarkdownFiles(remaining, workspaceId);
  } catch (error) {
    Logger.warn('deleteDocument: failed to drop the document from the vector store', error as Error);
  }

  // Clears the path from sync-state's dirty list, and bumps the timestamp the
  // QMD indexes use to decide they are stale.
  try {
    await DocumentUpdateService.getInstance().markGithubSyncSuccess({
      workspaceId,
      filePath,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      branch: repoInfo.branch,
      commitSha,
    });
  } catch (error) {
    Logger.warn('deleteDocument: failed to record the sync state', error as Error);
  }

  // No schedulePublish: there is no content left to push to a replica.
  scheduleQmdWarmup({ workspaceId, reason: 'docs-editor-delete' });

  return { commitSha, nextFilePath: pickNextDocument(surviving, filePath) };
}

/** Every markdown path in the mirror, repo-relative and sorted as the viewer sorts. */
async function listMarkdownPaths(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [repoRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      found.push(path.relative(repoRoot, entryPath).split(path.sep).join(path.posix.sep));
    }
  }

  return found.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}
