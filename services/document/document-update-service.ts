import { Logger } from 'services/common/logger';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

export class DocumentUpdateService {
  private static instance: DocumentUpdateService;

  public static getInstance(): DocumentUpdateService {
    if (!DocumentUpdateService.instance) {
      DocumentUpdateService.instance = new DocumentUpdateService();
    }

    return DocumentUpdateService.instance;
  }

  public async stageMarkdownUpdate(params: {
    workspaceId: string;
    filePath: string;
    content: string;
    owner?: string;
    repo?: string;
    branch?: string;
  }): Promise<void> {
    const mirrorService = WorkspaceMirrorService.getInstance();
    await mirrorService.writeMarkdownFile(params.workspaceId, params.filePath, params.content);
    await mirrorService.markFilesDirty({
      workspaceId: params.workspaceId,
      filePaths: [params.filePath],
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      source: 'document-update',
    });

    Logger.info(`DocumentUpdateService: staged markdown update`, {
      workspaceId: params.workspaceId,
      filePath: params.filePath,
    });
  }

  public async markGithubSyncSuccess(params: {
    workspaceId: string;
    filePath: string;
    owner?: string;
    repo?: string;
    branch?: string;
    commitSha?: string;
  }): Promise<void> {
    await WorkspaceMirrorService.getInstance().markFilesSynced({
      workspaceId: params.workspaceId,
      filePaths: [params.filePath],
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      commitSha: params.commitSha,
      source: 'document-update',
    });

    Logger.info(`DocumentUpdateService: marked markdown update as synced`, {
      workspaceId: params.workspaceId,
      filePath: params.filePath,
      commitSha: params.commitSha,
    });
  }

  public async persistRemoteFile(params: {
    workspaceId: string;
    filePath: string;
    content: string;
    owner?: string;
    repo?: string;
    branch?: string;
    commitSha?: string;
    source: 'create-file' | 'startup' | 'webhook' | 'manual-refresh';
  }): Promise<void> {
    const mirrorService = WorkspaceMirrorService.getInstance();
    await mirrorService.writeMarkdownFile(params.workspaceId, params.filePath, params.content);
    await mirrorService.markFilesSynced({
      workspaceId: params.workspaceId,
      filePaths: [params.filePath],
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      commitSha: params.commitSha,
      source: params.source,
    });

    Logger.info(`DocumentUpdateService: persisted remote file to workspace mirror`, {
      workspaceId: params.workspaceId,
      filePath: params.filePath,
      source: params.source,
    });
  }
}
