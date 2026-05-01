import { Logger } from 'services/common/logger';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService, type MarkdownFile } from 'services/github';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorMarkdownLoader } from 'services/workspace/mirror-markdown-loader';
import { WorkspaceMirrorService, type WorkspaceSyncSource } from 'services/workspace/mirror-service';

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
    }
  }

  public async syncWorkspaceFromGithub(params: {
    workspaceId: string;
    userId?: string;
    source: Extract<WorkspaceSyncSource, 'manual-refresh' | 'startup' | 'webhook'>;
  }): Promise<MarkdownFile[]> {
    const repoInfo = await getGithubRepo(params.workspaceId);
    if (!repoInfo) {
      throw new Error(`No GitHub repository configured for workspace ${params.workspaceId}`);
    }

    const markdownFiles = await GithubService.getInstance().getAllMarkdownFiles({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: repoInfo.path || '',
      ref: repoInfo.branch,
      workspaceId: params.workspaceId,
      userId: params.userId,
    });

    await this.syncWorkspaceFromMarkdownFiles({
      workspaceId: params.workspaceId,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      branch: repoInfo.branch || this.getBranchFromMarkdownFiles(markdownFiles),
      markdownFiles,
      source: params.source,
    });

    return markdownFiles;
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

  public async hydrateVectorStoreFromMirror(params: {
    workspaceId: string;
    owner: string;
    repo: string;
    branch?: string;
  }): Promise<boolean> {
    const mirroredMarkdownFiles = await this.mirrorMarkdownLoader.loadMarkdownFiles({
      workspaceId: params.workspaceId,
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
    });

    if (mirroredMarkdownFiles.length === 0) {
      Logger.info(`GitHubSyncService: no mirrored markdown files found for workspace ${params.workspaceId}`);
      return false;
    }

    VectorStoreService.getInstance().setLoadedMarkdownFiles(mirroredMarkdownFiles, params.workspaceId);
    Logger.info('GitHubSyncService: hydrated vector store metadata from mirror', {
      workspaceId: params.workspaceId,
      owner: params.owner,
      repo: params.repo,
      fileCount: mirroredMarkdownFiles.length,
    });
    return true;
  }
}
