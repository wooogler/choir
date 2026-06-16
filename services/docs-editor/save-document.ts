import { Logger } from 'services/common/logger';
import { parseMarkdownToTree } from 'services/document';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService, type MarkdownFile } from 'services/github';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { getGithubRepo } from 'services/slack';

export interface SaveDocumentResult {
  commitSha: string;
}

/**
 * Saves an edited markdown document: stages it to the workspace mirror, commits
 * to GitHub on the workspace's configured branch, then refreshes in-memory
 * vector store and schedules QMD index warmup so Q&A retrieval sees the change.
 */
export async function saveEditedDocument(params: {
  workspaceId: string;
  userId: string;
  filePath: string;
  content: string;
  commitMessage: string;
}): Promise<SaveDocumentResult> {
  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const documentUpdateService = DocumentUpdateService.getInstance();
  const githubService = GithubService.getInstance();
  const vectorStore = VectorStoreService.getInstance();

  await documentUpdateService.stageMarkdownUpdate({
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    content: params.content,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
  });

  const trimmedMessage = params.commitMessage.trim() || `Update ${params.filePath}`;

  const { commitSha } = await githubService.updateMarkdownFile({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    path: params.filePath,
    content: params.content,
    message: trimmedMessage,
    branch: repoInfo.branch,
    workspaceId: params.workspaceId,
    userId: params.userId,
  });

  await documentUpdateService.markGithubSyncSuccess({
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    commitSha,
  });

  try {
    const fileName = params.filePath.split('/').pop() || params.filePath;
    const tree = parseMarkdownToTree(params.content, fileName);
    const existing = vectorStore.getMarkdownFile(fileName, params.workspaceId);
    const branchSegment = repoInfo.branch || 'main';
    const encodedPath = params.filePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const githubUrl =
      existing?.githubUrl ??
      `https://github.com/${repoInfo.owner}/${repoInfo.repo}/blob/${branchSegment}/${encodedPath}`;

    const allFiles = vectorStore.getAllMarkdownFiles(params.workspaceId);
    const updatedFile: MarkdownFile = {
      name: fileName,
      path: params.filePath,
      content: params.content,
      githubUrl,
      tree,
    };
    const next = allFiles.filter((file) => file.name !== fileName);
    next.push(updatedFile);
    vectorStore.setLoadedMarkdownFiles(next, params.workspaceId);
  } catch (error) {
    Logger.warn('saveEditedDocument: failed to refresh in-memory vector store entry', error as Error);
  }

  scheduleQmdWarmup({
    workspaceId: params.workspaceId,
    reason: 'docs-editor-save',
  });

  Logger.info('saveEditedDocument: committed and indexed', {
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    commitSha,
    userId: params.userId,
  });

  return { commitSha };
}
