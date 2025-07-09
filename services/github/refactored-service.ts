import { Logger } from 'services/common/logger';
import { GitHubCommitManager, type GithubCommit } from './commit-manager';
import { GitHubFileManager, type MarkdownFile } from './file-manager';
import { WorkspaceStore } from 'services/workspace/workspace-store';

/**
 * 리팩토링된 GitHub 서비스 - 파일 관리와 커밋 관리를 분리
 */
class RefactoredGithubService {
  private static instance: RefactoredGithubService;
  private defaultFileManager: GitHubFileManager;
  private defaultCommitManager: GitHubCommitManager;
  private workspaceStore: WorkspaceStore;

  private constructor() {
    this.defaultFileManager = new GitHubFileManager();
    this.defaultCommitManager = new GitHubCommitManager();
    this.workspaceStore = new WorkspaceStore();
    Logger.info('RefactoredGithubService instance created');
  }

  public static getInstance(): RefactoredGithubService {
    if (!RefactoredGithubService.instance) {
      RefactoredGithubService.instance = new RefactoredGithubService();
    }
    return RefactoredGithubService.instance;
  }

  /**
   * 워크스페이스와 사용자 컨텍스트에서 적절한 GitHub 토큰을 가져옴
   */
  private async getGitHubToken(workspaceId?: string, userId?: string): Promise<string | undefined> {
    if (!workspaceId || !userId) {
      return process.env.GITHUB_TOKEN;
    }

    try {
      const userToken = await this.workspaceStore.getUserGithubToken(workspaceId, userId);
      if (userToken) {
        Logger.info(`Using user GitHub token for ${userId} in workspace ${workspaceId}`);
        return userToken;
      }
    } catch (error) {
      Logger.warn(`Failed to get user GitHub token for ${userId}:`, error as Error);
    }

    Logger.info('Falling back to environment GitHub token');
    return process.env.GITHUB_TOKEN;
  }

  /**
   * 적절한 토큰으로 GitHubFileManager 인스턴스 생성
   */
  private async getFileManager(workspaceId?: string, userId?: string): Promise<GitHubFileManager> {
    const token = await this.getGitHubToken(workspaceId, userId);
    if (token) {
      return new GitHubFileManager(token);
    }
    return this.defaultFileManager;
  }

  /**
   * 적절한 토큰으로 GitHubCommitManager 인스턴스 생성
   */
  private async getCommitManager(workspaceId?: string, userId?: string): Promise<GitHubCommitManager> {
    const token = await this.getGitHubToken(workspaceId, userId);
    if (token) {
      return new GitHubCommitManager(token);
    }
    return this.defaultCommitManager;
  }

  // File management delegation
  async getAllMarkdownFiles(params: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<MarkdownFile[]> {
    const fileManager = await this.getFileManager(params.workspaceId, params.userId);
    return fileManager.getAllMarkdownFiles(params);
  }

  async getMarkdownFile(params: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<MarkdownFile | null> {
    const fileManager = await this.getFileManager(params.workspaceId, params.userId);
    return fileManager.getMarkdownFile(params);
  }

  async updateMarkdownFile(params: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message?: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<void> {
    const fileManager = await this.getFileManager(params.workspaceId, params.userId);
    return fileManager.updateMarkdownFile(params);
  }

  async testConnection(params: {
    owner: string;
    repo: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<{ success: boolean; message: string }> {
    const fileManager = await this.getFileManager(params.workspaceId, params.userId);
    return fileManager.testConnection(params);
  }

  // Commit management delegation
  async getHistoryOfMarkdownUpdate(params: {
    owner: string;
    repo: string;
    path: string;
    newContent: string;
    limit?: number;
    workspaceId?: string;
    userId?: string;
  }): Promise<GithubCommit[]> {
    const commitManager = await this.getCommitManager(params.workspaceId, params.userId);
    return commitManager.getHistoryOfMarkdownUpdate(params);
  }

  async createCommitMessage(
    fileName: string,
    userId: string,
    nodeId: string,
    knowledgeContent: string,
    sourceMessages: any[],
    client: any,
    workspaceId?: string,
  ): Promise<string> {
    const commitManager = await this.getCommitManager(workspaceId, userId);
    return commitManager.createCommitMessage(fileName, userId, nodeId, knowledgeContent, sourceMessages, client);
  }
}

export default RefactoredGithubService;
