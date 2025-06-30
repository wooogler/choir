import { Logger } from 'services/common/logger';
import { GitHubCommitManager, type GithubCommit } from './commit-manager';
import { GitHubFileManager, type MarkdownFile } from './file-manager';

/**
 * 리팩토링된 GitHub 서비스 - 파일 관리와 커밋 관리를 분리
 */
class RefactoredGithubService {
  private static instance: RefactoredGithubService;
  private fileManager: GitHubFileManager;
  private commitManager: GitHubCommitManager;

  private constructor() {
    this.fileManager = new GitHubFileManager();
    this.commitManager = new GitHubCommitManager();
    Logger.info('RefactoredGithubService instance created');
  }

  public static getInstance(): RefactoredGithubService {
    if (!RefactoredGithubService.instance) {
      RefactoredGithubService.instance = new RefactoredGithubService();
    }
    return RefactoredGithubService.instance;
  }

  // File management delegation
  async getAllMarkdownFiles(params: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<MarkdownFile[]> {
    return this.fileManager.getAllMarkdownFiles(params);
  }

  async getMarkdownFile(params: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<MarkdownFile | null> {
    return this.fileManager.getMarkdownFile(params);
  }

  async updateMarkdownFile(params: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message?: string;
  }): Promise<void> {
    return this.fileManager.updateMarkdownFile(params);
  }

  async testConnection(params: {
    owner: string;
    repo: string;
  }): Promise<{ success: boolean; message: string }> {
    return this.fileManager.testConnection(params);
  }

  // Commit management delegation
  async getHistoryOfMarkdownUpdate(params: {
    owner: string;
    repo: string;
    path: string;
    newContent: string;
    limit?: number;
  }): Promise<GithubCommit[]> {
    return this.commitManager.getHistoryOfMarkdownUpdate(params);
  }

  async createCommitMessage(
    fileName: string,
    userId: string,
    nodeId: string,
    knowledgeContent: string,
    sourceMessages: any[],
    client: any,
  ): Promise<string> {
    return this.commitManager.createCommitMessage(fileName, userId, nodeId, knowledgeContent, sourceMessages, client);
  }
}

export default RefactoredGithubService;
