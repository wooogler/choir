import type { WebClient } from '@slack/web-api';
import { Octokit } from 'octokit';
import { ErrorCodes, GitHubError } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import { type DocumentTree, parseMarkdownToTree } from 'services/document';
import type { SlackMessage } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';

export interface MarkdownFile {
  name: string;
  path: string;
  content: string;
  githubUrl: string;
  tree: DocumentTree;
}

export interface GithubCommit {
  author: string;
  message: string;
  description: string;
  date: string;
  commitInfo?: CommitInfo;
}

export interface CommitInfo {
  fileName: string;
  updateType: string;
  source: string;
  timestamp: string;
  updatedBy: string;
  nodeIds: string[];
  messages: CommitMessage[];
}

export interface CommitMessage {
  userId: string;
  username: string;
  text: string;
  ts: string;
}

interface ThrottleOptions {
  maxConcurrent: number;
  retryAttempts: number;
  baseDelay: number;
}

interface FileTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url: string;
}

interface FileContentCache {
  sha: string;
  content: string;
  lastModified: Date;
}

/**
 * 중앙화된 GitHub 서비스 - 모든 GitHub API 호출의 단일 진입점
 */
class GithubService {
  private static instance: GithubService;
  private workspaceStore: WorkspaceStore;
  private octokitInstances: Map<string, Octokit> = new Map();
  private throttleOptions: ThrottleOptions = {
    maxConcurrent: 3,
    retryAttempts: 3,
    baseDelay: 1000,
  };
  private fileContentCache = new Map<string, FileContentCache>();

  private constructor() {
    this.workspaceStore = new WorkspaceStore();
    Logger.info('GithubService instance created');
  }

  public static getInstance(): GithubService {
    if (!GithubService.instance) {
      GithubService.instance = new GithubService();
    }
    return GithubService.instance;
  }

  /**
   * 워크스페이스와 사용자 컨텍스트에서 적절한 GitHub 토큰을 가져옴
   * 환경 변수 토큰이 있으면 항상 우선 사용
   */
  private async getGitHubToken(workspaceId?: string, userId?: string): Promise<string | undefined> {
    // 환경 변수 토큰이 있으면 항상 우선 사용
    if (process.env.GITHUB_TOKEN) {
      Logger.info('Using environment GitHub token');
      return process.env.GITHUB_TOKEN;
    }

    if (!workspaceId || !userId) {
      return undefined;
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

    Logger.warn('No GitHub token available');
    return undefined;
  }

  /**
   * 토큰에 따라 적절한 Octokit 인스턴스를 가져옴 (캐시됨)
   */
  private async getOctokit(workspaceId?: string, userId?: string): Promise<Octokit> {
    const token = await this.getGitHubToken(workspaceId, userId);
    const tokenKey = token || 'no-token';

    if (!this.octokitInstances.has(tokenKey)) {
      this.octokitInstances.set(
        tokenKey,
        new Octokit({
          auth: token,
        }),
      );
      Logger.info(`Created new Octokit instance for token: ${tokenKey.substring(0, 10)}...`);
    }

    return this.octokitInstances.get(tokenKey)!;
  }

  // Utility methods
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async throttledRequest<T>(fn: () => Promise<T>, retries = this.throttleOptions.retryAttempts): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error: any) {
        if (error.status === 403 || error.status === 429) {
          const delayMs = this.throttleOptions.baseDelay * Math.pow(2, i);
          Logger.warn(`Rate limit hit, retrying in ${delayMs}ms (attempt ${i + 1}/${retries})`);
          await this.delay(delayMs);
        } else {
          throw error;
        }
      }
    }
    throw new Error(`Max retries (${retries}) exceeded`);
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  public async getDefaultBranch(owner: string, repo: string, workspaceId?: string, userId?: string): Promise<string> {
    try {
      const octokit = await this.getOctokit(workspaceId, userId);
      const response = await this.throttledRequest(() =>
        octokit.rest.repos.get({
          owner,
          repo,
        }),
      );
      const data = (response as any).data;
      return data.default_branch;
    } catch (error) {
      Logger.debug(`Repository ${owner}/${repo} not accessible, using 'main' as default branch`);
      return 'main';
    }
  }

  // File management methods
  async getAllMarkdownFiles(params: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<MarkdownFile[]> {
    try {
      const octokit = await this.getOctokit(params.workspaceId, params.userId);
      const actualRef =
        params.ref || (await this.getDefaultBranch(params.owner, params.repo, params.workspaceId, params.userId));
      Logger.info(`Using efficient Tree API to scan ${params.owner}/${params.repo} for markdown files`);

      // 1. Get repository tree using Tree API (single API call)
      const treeResponse = await this.throttledRequest(() =>
        octokit.rest.git.getTree({
          owner: params.owner,
          repo: params.repo,
          tree_sha: actualRef,
          recursive: true,
        }),
      );
      const tree = (treeResponse as any).data;

      // 2. Filter markdown files from tree
      const markdownTreeItems = tree.tree.filter(
        (item: any) =>
          item.type === 'blob' &&
          item.path &&
          item.path.endsWith('.md') &&
          (params.path === '' || item.path.startsWith(params.path)),
      ) as FileTreeItem[];

      Logger.info(`Found ${markdownTreeItems.length} markdown files in tree`);

      if (markdownTreeItems.length === 0) {
        return [];
      }

      // 3. Fetch file contents in batches with concurrency control
      const allMarkdownFiles: MarkdownFile[] = [];
      const chunks = this.chunkArray(markdownTreeItems, this.throttleOptions.maxConcurrent);

      for (const chunk of chunks) {
        const filePromises = chunk.map(async (item) => {
          try {
            // Check cache first
            const cacheKey = `${params.owner}/${params.repo}/${item.path}:${item.sha}`;
            const cached = this.fileContentCache.get(cacheKey);

            if (cached && cached.sha === item.sha) {
              Logger.debug(`Using cached content for ${item.path}`);
              return {
                item,
                content: cached.content,
              };
            }

            // Fetch from GitHub using blob API (more efficient than content API)
            const blobResponse = await this.throttledRequest(() =>
              octokit.rest.git.getBlob({
                owner: params.owner,
                repo: params.repo,
                file_sha: item.sha,
              }),
            );
            const blobData = (blobResponse as any).data;

            const content = Buffer.from(blobData.content, 'base64').toString('utf-8');

            // Cache the content
            this.fileContentCache.set(cacheKey, {
              sha: item.sha,
              content,
              lastModified: new Date(),
            });

            return {
              item,
              content,
            };
          } catch (error) {
            Logger.error(`Error loading file ${item.path}`, error as Error);
            return null;
          }
        });

        const results = await Promise.all(filePromises);

        // Process successful results
        for (const result of results) {
          if (result) {
            try {
              const { item, content } = result;
              const tree = parseMarkdownToTree(content, item.path.split('/').pop() || '');

              // Construct GitHub URL with proper encoding for file path
              // Split path by '/' and encode each segment individually to preserve path structure
              const encodedPath = item.path
                .split('/')
                .map((segment) => encodeURIComponent(segment))
                .join('/');
              const githubUrl = `https://github.com/${params.owner}/${params.repo}/blob/${actualRef}/${encodedPath}`;

              allMarkdownFiles.push({
                name: item.path.split('/').pop() || '',
                path: item.path,
                content,
                githubUrl,
                tree,
              });

              Logger.info(`Loaded markdown file: ${item.path}`);
            } catch (parseError) {
              Logger.error(`Error parsing markdown file ${result.item.path}`, parseError as Error);
            }
          }
        }
      }

      Logger.info(`Loaded ${allMarkdownFiles.length} markdown files total using efficient Tree API`);
      return allMarkdownFiles;
    } catch (error) {
      Logger.error(`Repository ${params.owner}/${params.repo} not accessible or empty`, error as Error);
      throw new GitHubError('Failed to load markdown files', {
        code: ErrorCodes.GITHUB_CONNECTION_FAILED,
        metadata: { owner: params.owner, repo: params.repo, path: params.path },
      });
    }
  }

  async getMarkdownFile(params: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<MarkdownFile | null> {
    try {
      const octokit = await this.getOctokit(params.workspaceId, params.userId);
      const actualRef =
        params.ref || (await this.getDefaultBranch(params.owner, params.repo, params.workspaceId, params.userId));
      Logger.info(`Loading markdown file: ${params.path} (${params.owner}/${params.repo})`);

      const fileResponse = await this.throttledRequest(() =>
        octokit.rest.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: actualRef,
        }),
      );
      const fileData = (fileResponse as any).data;

      if (Array.isArray(fileData) || !('content' in fileData)) {
        Logger.warn(`Cannot get content for ${params.path}`);
        return null;
      }

      const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
      const tree = parseMarkdownToTree(content, params.path.split('/').pop() || '');

      const markdownFile: MarkdownFile = {
        name: fileData.name,
        path: fileData.path,
        content,
        githubUrl: fileData.html_url,
        tree,
      };

      Logger.info(`Markdown file loaded: ${params.path} (${content.length} bytes)`);
      return markdownFile;
    } catch (error) {
      Logger.error(`Error loading file ${params.path}`, error as Error);
      return null;
    }
  }

  async updateMarkdownFile(params: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message?: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<{ commitSha: string }> {
    try {
      const octokit = await this.getOctokit(params.workspaceId, params.userId);
      const currentFileResponse = await this.throttledRequest(() =>
        octokit.rest.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
        }),
      );
      const currentFile = (currentFileResponse as any).data;

      if (Array.isArray(currentFile) || !('sha' in currentFile)) {
        throw new GitHubError('Invalid file data', {
          code: ErrorCodes.GITHUB_FILE_NOT_FOUND,
        });
      }

      const updateResponse = await this.throttledRequest(() =>
        octokit.rest.repos.createOrUpdateFileContents({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          message: params.message || 'Update markdown content',
          content: Buffer.from(params.content).toString('base64'),
          sha: currentFile.sha,
        }),
      );
      
      const commitSha = (updateResponse as any).data.commit.sha;

      // Invalidate cache for this file
      const cacheKeys = Array.from(this.fileContentCache.keys()).filter((key) =>
        key.startsWith(`${params.owner}/${params.repo}/${params.path}:`),
      );
      cacheKeys.forEach((key) => this.fileContentCache.delete(key));

      Logger.info(`Successfully updated file: ${params.path}`);
      return { commitSha };
    } catch (error) {
      Logger.error('Failed to update file', error as Error, {
        owner: params.owner,
        repo: params.repo,
        path: params.path,
      });
      throw new GitHubError('Failed to update file', {
        code: ErrorCodes.GITHUB_UPDATE_FAILED,
        metadata: { owner: params.owner, repo: params.repo, path: params.path },
      });
    }
  }

  async testConnection(params: {
    owner: string;
    repo: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      const octokit = await this.getOctokit(params.workspaceId, params.userId);
      const response = await this.throttledRequest(() =>
        octokit.rest.repos.get({
          owner: params.owner,
          repo: params.repo,
        }),
      );
      const data = (response as any).data;

      const message = `Repository connection successful: ${data.full_name} (${data.description || 'No description'})`;
      Logger.info('GitHub connection test successful', { owner: params.owner, repo: params.repo });

      return {
        success: true,
        message,
      };
    } catch (error: unknown) {
      Logger.error('GitHub connection test failed', error as Error, { owner: params.owner, repo: params.repo });

      interface ErrorWithStatus {
        status?: number;
        message?: string;
      }

      const err = error as ErrorWithStatus;

      if (err.status === 404) {
        return {
          success: false,
          message: `Repository not found: ${params.owner}/${params.repo}. Please check the repository name.`,
        };
      } else if (err.status === 401 || err.status === 403) {
        return {
          success: false,
          message: 'Authentication failed: GitHub token is invalid or lacks permissions.',
        };
      } else {
        return {
          success: false,
          message: `GitHub connection failed: ${err.message || 'Unknown error'}`,
        };
      }
    }
  }

  // Commit management methods
  async getHistoryOfMarkdownUpdate(params: {
    owner: string;
    repo: string;
    path: string;
    newContent: string;
    limit?: number;
    workspaceId?: string;
    userId?: string;
  }): Promise<GithubCommit[]> {
    try {
      const octokit = await this.getOctokit(params.workspaceId, params.userId);
      const { data: currentFile } = await octokit.rest.repos.getContent({
        owner: params.owner,
        repo: params.repo,
        path: params.path,
      });

      if (Array.isArray(currentFile) || !('content' in currentFile)) {
        throw new GitHubError('Invalid file data', {
          code: ErrorCodes.GITHUB_FILE_NOT_FOUND,
        });
      }

      const currentContent = Buffer.from(currentFile.content, 'base64').toString();
      const currentLines = currentContent.split('\n');
      const newLines = params.newContent.split('\n');
      const changedLineNumbers = new Set<number>();

      for (let i = 0; i < Math.max(currentLines.length, newLines.length); i++) {
        if (currentLines[i] !== newLines[i]) {
          changedLineNumbers.add(i + 1);
        }
      }

      const { data: commits } = await octokit.rest.repos.listCommits({
        owner: params.owner,
        repo: params.repo,
        path: params.path,
      });

      const relevantCommits = await Promise.all(
        commits.map(async (commit: any) => {
          const { data: commitData } = await octokit.rest.repos.getCommit({
            owner: params.owner,
            repo: params.repo,
            ref: commit.sha,
          });

          const fileChange = commitData.files?.find((file: any) => file.filename === params.path);
          if (!fileChange) return null;

          const commitChangedLines = new Set<number>();
          const patch = fileChange.patch ?? '';
          const patchLines = patch.split('\n');

          let targetLineNumber = 0;

          for (let i = 0; i < patchLines.length; i++) {
            const line = patchLines[i];

            if (line.startsWith('@@')) {
              const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
              if (match && match[1]) {
                targetLineNumber = Number.parseInt(match[1], 10) - 1;
              }
              continue;
            }

            if (line.startsWith(' ')) {
              targetLineNumber++;
            } else if (line.startsWith('+')) {
              targetLineNumber++;
              commitChangedLines.add(targetLineNumber);
            }
          }

          const hasRelevantChanges = Array.from(changedLineNumbers).some((line) => commitChangedLines.has(line));

          if (!hasRelevantChanges) return null;

          let message = '';
          let description = '';
          let commitInfo: CommitInfo | null = null;

          try {
            const commitMessage = (commit as any).commit.message;
            if (commitMessage.startsWith('{') && commitMessage.endsWith('}')) {
              commitInfo = JSON.parse(commitMessage);

              if (!commitInfo) {
                throw new Error('Invalid commit message');
              }

              message = `Document update: ${commitInfo.fileName}`;
              description = commitInfo.toString();
            } else {
              const messageLines = commitMessage.split('\n');
              message = messageLines[0];
              description = messageLines.slice(1).join('\n').trim();
            }
          } catch (error) {
            const messageLines = (commit as any).commit.message.split('\n');
            message = messageLines[0];
            description = messageLines.slice(1).join('\n').trim();
          }

          return {
            author: (commit as any).commit.author?.name ?? 'Unknown',
            message: message,
            description: description,
            date: (commit as any).commit.author?.date ?? '',
            commitInfo,
          };
        }),
      );

      const filteredCommits = relevantCommits.filter(
        (commit: any): commit is NonNullable<typeof commit> => commit !== null,
      );

      if (params.limit && params.limit > 0) {
        return filteredCommits.slice(0, params.limit);
      }

      return filteredCommits;
    } catch (error) {
      Logger.error('Failed to get commit history', error as Error);
      throw new GitHubError('Failed to get commit history', {
        code: ErrorCodes.GITHUB_CONNECTION_FAILED,
        metadata: { owner: params.owner, repo: params.repo, path: params.path },
      });
    }
  }

  async createCommitMessage(
    fileName: string,
    userId: string,
    _nodeId: string,
    _knowledgeContent: string,
    _sourceMessages: SlackMessage[],
    client: WebClient,
    _workspaceId?: string,
  ): Promise<string> {
    let updatedByUserName = 'Unknown User';
    try {
      const userInfo = await client.users.info({ user: userId });
      updatedByUserName = userInfo.user?.real_name || userInfo.user?.name || 'Unknown User';
    } catch (error) {
      Logger.error('Failed to get user info for commit message', error as Error, { userId });
    }

    // 간단한 커밋 메시지 생성 (CHOIR에서 생성됨을 표시)
    return `Update ${fileName} - ${updatedByUserName} [choir-auto]`;
  }

  /**
   * Create a new file in the repository
   */
  async createFile(params: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<void> {
    try {
      const octokit = await this.getOctokit(params.workspaceId, params.userId);
      const defaultBranch = await this.getDefaultBranch(params.owner, params.repo, params.workspaceId, params.userId);

      // Check if file already exists
      try {
        await octokit.rest.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: defaultBranch,
        });

        // If we get here, file exists
        throw new GitHubError('File already exists', {
          code: ErrorCodes.GITHUB_FILE_EXISTS,
          metadata: { owner: params.owner, repo: params.repo, path: params.path },
        });
      } catch (error: any) {
        // If error status is 404, file doesn't exist - proceed with creation
        if (error.status !== 404) {
          throw error; // Re-throw non-404 errors
        }
      }

      // Create the file
      await this.throttledRequest(async () => {
        return octokit.rest.repos.createOrUpdateFileContents({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          message: params.message,
          content: Buffer.from(params.content).toString('base64'),
          branch: defaultBranch,
        });
      });

      Logger.info(`Successfully created file ${params.path} in ${params.owner}/${params.repo}`);
    } catch (error) {
      Logger.error('Failed to create file', error as Error);
      throw new GitHubError('Failed to create file', {
        code: ErrorCodes.GITHUB_CONNECTION_FAILED,
        metadata: { owner: params.owner, repo: params.repo, path: params.path },
      });
    }
  }

  /**
   * Get a file from the repository
   */
  async getFile(params: {
    owner: string;
    repo: string;
    path: string;
    workspaceId?: string;
    userId?: string;
  }): Promise<{ content: string; sha: string } | null> {
    try {
      const octokit = await this.getOctokit(params.workspaceId, params.userId);
      const defaultBranch = await this.getDefaultBranch(params.owner, params.repo, params.workspaceId, params.userId);

      const response = await this.throttledRequest(async () => {
        return octokit.rest.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: defaultBranch,
        });
      });

      if ('content' in response.data && typeof response.data.content === 'string') {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        return {
          content,
          sha: response.data.sha,
        };
      }

      return null;
    } catch (error: any) {
      if (error.status === 404) {
        Logger.warn(`File not found: ${params.path} in ${params.owner}/${params.repo}`);
        return null;
      }

      Logger.error('Failed to get file', error as Error);
      throw new GitHubError('Failed to get file', {
        code: ErrorCodes.GITHUB_CONNECTION_FAILED,
        metadata: { owner: params.owner, repo: params.repo, path: params.path },
      });
    }
  }

  // Cache management methods
  public clearCache(): void {
    this.fileContentCache.clear();
    this.octokitInstances.clear();
    Logger.info('File content cache and Octokit instances cleared');
  }

  public getCacheSize(): number {
    return this.fileContentCache.size;
  }

  public getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.fileContentCache.size,
      keys: Array.from(this.fileContentCache.keys()),
    };
  }
}

export default GithubService;
