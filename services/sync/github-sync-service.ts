import { Logger } from 'services/common/logger';
import { enrichWorkspaceImageCaptions } from 'services/document/image-captions';
import { GithubService, type MarkdownFile } from 'services/github';
import { schedulePublishAll } from 'services/google/replica-publisher';
import { invalidateProjectIndex } from 'services/projects/project-index';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { WorkspaceMirrorMarkdownLoader } from 'services/workspace/mirror-markdown-loader';
import { WorkspaceMirrorService, type WorkspaceSyncSource } from 'services/workspace/mirror-service';
import { syncProjectFiles } from './project-file-sync';

export class GitHubSyncService {
  private static instance: GitHubSyncService;
  private readonly mirrorMarkdownLoader = WorkspaceMirrorMarkdownLoader.getInstance();

  private getBranchFromMarkdownFiles(markdownFiles: MarkdownFile[]): string | undefined {
    for (const file of markdownFiles) {
      const match = file.githubUrl.match(/\/blob\/([^/]+)\//);
      if (match?.[1]) {
        return match[1];
      }
    }

    return undefined;
  }

  public static getInstance(): GitHubSyncService {
    if (!GitHubSyncService.instance) {
      GitHubSyncService.instance = new GitHubSyncService();
    }

    return GitHubSyncService.instance;
  }

  public async syncWorkspaceFromMarkdownFiles(params: {
    workspaceId: string;
    owner: string;
    repo: string;
    branch?: string;
    markdownFiles: MarkdownFile[];
    source: WorkspaceSyncSource;
    commitSha?: string;
  }): Promise<void> {
    const branch = params.branch || this.getBranchFromMarkdownFiles(params.markdownFiles);
    await WorkspaceMirrorService.getInstance().syncMarkdownFiles({
      ...params,
      branch,
    });

    // The mirror only receives the markdown it is handed, so the project files
    // are fetched separately — otherwise a `.choir/project.json` that never
    // passed through the viewer's GUI (a fresh instance, or an edit made on
    // GitHub) would never reach this instance at all. Best-effort: a question
    // answered workspace-wide is a worse answer, a failed sync is no answer.
    try {
      await syncProjectFiles({
        workspaceId: params.workspaceId,
        owner: params.owner,
        repo: params.repo,
        branch,
      });
    } catch (error) {
      Logger.warn('GitHubSyncService: project file sync failed', error as Error);
    }

    // After both writes: the index is rebuilt from whatever the mirror holds,
    // so invalidating it earlier would just cache the pre-sync tree again.
    invalidateProjectIndex(params.workspaceId);

    Logger.info(`GitHubSyncService: synced ${params.markdownFiles.length} markdown files to workspace mirror`, {
      workspaceId: params.workspaceId,
      owner: params.owner,
      repo: params.repo,
      branch,
      source: params.source,
    });

    if (params.source !== 'startup') {
      scheduleQmdWarmup({
        workspaceId: params.workspaceId,
        reason: `github-sync:${params.source}`,
      });

      // Caption images surfaced by this sync (best-effort, non-blocking).
      void enrichWorkspaceImageCaptions(params.workspaceId).catch((error) => {
        Logger.warn('GitHubSyncService: image caption enrichment failed', error as Error);
      });

      // Republish any documents with a Google Docs replica. This is the full
      // file set rather than a delta; the publisher filters to linked paths and
      // skips content it has already pushed.
      schedulePublishAll(params.workspaceId, params.markdownFiles, `github-sync:${params.source}`);
    }
  }

  public async loadWorkspaceMarkdownFiles(params: {
    workspaceId: string;
    owner: string;
    repo: string;
    branch?: string;
    path?: string;
    userId?: string;
    source: Extract<WorkspaceSyncSource, 'manual-refresh' | 'startup' | 'webhook'>;
    preferMirror?: boolean;
  }): Promise<{ markdownFiles: MarkdownFile[]; loadedFrom: 'mirror' | 'github' | 'empty' }> {
    const preferMirror = params.preferMirror ?? process.env.RETRIEVAL_MIRROR_FIRST !== 'false';

    if (preferMirror) {
      const mirroredMarkdownFiles = await this.mirrorMarkdownLoader.loadMarkdownFiles({
        workspaceId: params.workspaceId,
        owner: params.owner,
        repo: params.repo,
        branch: params.branch,
      });

      if (mirroredMarkdownFiles.length > 0) {
        return {
          markdownFiles: mirroredMarkdownFiles,
          loadedFrom: 'mirror',
        };
      }
    }

    const markdownFiles = await GithubService.getInstance().getAllMarkdownFiles({
      owner: params.owner,
      repo: params.repo,
      path: params.path || '',
      ref: params.branch,
      workspaceId: params.workspaceId,
      userId: params.userId,
    });

    if (markdownFiles.length === 0) {
      return {
        markdownFiles,
        loadedFrom: 'empty',
      };
    }

    await this.syncWorkspaceFromMarkdownFiles({
      workspaceId: params.workspaceId,
      owner: params.owner,
      repo: params.repo,
      branch: params.branch || this.getBranchFromMarkdownFiles(markdownFiles),
      markdownFiles,
      source: params.source,
    });

    return {
      markdownFiles,
      loadedFrom: 'github',
    };
  }
}
