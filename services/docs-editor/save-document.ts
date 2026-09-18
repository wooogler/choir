import { Logger } from 'services/common/logger';
import { parseMarkdownToTree } from 'services/document';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { enrichWorkspaceImageCaptions } from 'services/document/image-captions';
import {
  type ProvenanceRecord,
  type ProvenanceType,
  buildContextFile,
  persistContextToMirror,
} from 'services/document/provenance';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService, type MarkdownFile } from 'services/github';
import { schedulePublish } from 'services/google/replica-publisher';
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
  /**
   * How the change is recorded in provenance. Creating a document runs through
   * this same path — commit, mirror, index, publish — and differs only in that
   * the viewer should call it a new file rather than an edit.
   */
  provenanceType?: ProvenanceType;
}): Promise<SaveDocumentResult> {
  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const documentUpdateService = DocumentUpdateService.getInstance();
  const githubService = GithubService.getInstance();
  const vectorStore = VectorStoreService.getInstance();

  // Capture pre-save content for the provenance diff before the mirror/index is
  // overwritten below. Look up by full path so nested docs (and siblings sharing
  // a basename) resolve to the correct entry.
  const editedFileName = params.filePath.split('/').pop() || params.filePath;
  const beforeContent = vectorStore.getMarkdownFile(params.filePath, params.workspaceId)?.content ?? '';

  const trimmedMessage = params.commitMessage.trim() || `Update ${params.filePath}`;

  // Manual web edit: provenance carries the manager + diff (no conversation),
  // and no `source` — there is no thread or Doc behind it. A creation lands here
  // as 'new-file', where `beforeContent` is already the empty string the type
  // expects, because nothing was indexed under the path.
  const record: ProvenanceRecord = {
    version: 1,
    type: params.provenanceType ?? 'web-edit',
    file: { path: params.filePath, name: editedFileName },
    createdAt: new Date().toISOString(),
    updatedBy: { userId: params.userId },
    knowledge: '',
    messages: [],
    diff: { before: beforeContent, after: params.content },
  };
  const contextFile = await buildContextFile({
    workspaceId: params.workspaceId,
    docPath: params.filePath,
    record,
  });

  // Commit BEFORE touching the local mirror. The mirror is what the docs viewer
  // and Q&A read, so staging first meant a rejected push (no write access to the
  // repo, a protected branch, GitHub down) left CHOIR serving an edit that does
  // not exist on GitHub, with nothing to reconcile it. Nothing below the commit
  // needs the staged copy, so the remote write is the safe first step.
  const { commitSha } = await githubService.commitFilesWithContext({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    message: trimmedMessage,
    files: [{ path: params.filePath, content: params.content }, contextFile],
    workspaceId: params.workspaceId,
    userId: params.userId,
  });

  await documentUpdateService.stageMarkdownUpdate({
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    content: params.content,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
  });
  await persistContextToMirror(params.workspaceId, contextFile);

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
    const existing = vectorStore.getMarkdownFile(params.filePath, params.workspaceId);
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
    // De-dupe by full path so a sibling doc that merely shares this basename
    // (e.g. another README.md in a different folder) is not dropped from the
    // in-memory store.
    const next = allFiles.filter((file) => file.path !== params.filePath);
    next.push(updatedFile);
    vectorStore.setLoadedMarkdownFiles(next, params.workspaceId);
  } catch (error) {
    Logger.warn('saveEditedDocument: failed to refresh in-memory vector store entry', error as Error);
  }

  // The commit above is marked [choir-auto], so the GitHub webhook skips it and
  // the full-sync replica hook never runs for web edits. Publish here instead.
  schedulePublish({
    workspaceId: params.workspaceId,
    githubPath: params.filePath,
    markdown: params.content,
    reason: 'docs-editor-save',
  });

  scheduleQmdWarmup({
    workspaceId: params.workspaceId,
    reason: 'docs-editor-save',
  });

  // Caption any images in the saved document so they become searchable and get
  // a visible caption written back. Fire-and-forget — vision calls and the
  // follow-up commit must never block the save.
  void enrichWorkspaceImageCaptions(params.workspaceId, { userId: params.userId }).catch((error) => {
    Logger.warn('saveEditedDocument: image caption enrichment failed', error as Error);
  });

  Logger.info('saveEditedDocument: committed and indexed', {
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    commitSha,
    userId: params.userId,
  });

  return { commitSha };
}
