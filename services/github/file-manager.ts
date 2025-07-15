import { Octokit } from 'octokit';
import { ErrorCodes, GitHubError } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import { type DocumentTree, parseMarkdownToTree } from 'services/document';

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

export interface MarkdownFile {
  name: string;
  path: string;
  content: string;
  githubUrl: string;
  tree: DocumentTree;
}

export class GitHubFileManager {
  private octokit: Octokit;
  private throttleOptions: ThrottleOptions = {
    maxConcurrent: 3,
    retryAttempts: 3,
    baseDelay: 1000,
  };
  private fileContentCache = new Map<string, FileContentCache>();

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token || process.env.GITHUB_TOKEN,
    });
  }

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

  private async getDefaultBranch(owner: string, repo: string): Promise<string> {
    try {
      const response = await this.throttledRequest(() =>
        this.octokit.rest.repos.get({
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

  async getAllMarkdownFiles({
    owner,
    repo,
    path,
    ref,
  }: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<MarkdownFile[]> {
    try {
      const actualRef = ref || (await this.getDefaultBranch(owner, repo));
      Logger.info(`Using efficient Tree API to scan ${owner}/${repo} for markdown files`);

      // 1. Get repository tree using Tree API (single API call)
      const treeResponse = await this.throttledRequest(() =>
        this.octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: actualRef,
          recursive: true,
        }),
      );
      const tree = (treeResponse as any).data;

      // 2. Filter markdown files from tree
      const markdownTreeItems = tree.tree.filter(
        (item: any) =>
          item.type === 'blob' && item.path && item.path.endsWith('.md') && (path === '' || item.path.startsWith(path)),
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
            const cacheKey = `${owner}/${repo}/${item.path}:${item.sha}`;
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
              this.octokit.rest.git.getBlob({
                owner,
                repo,
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
              const encodedPath = item.path.split('/').map(segment => encodeURIComponent(segment)).join('/');
              const githubUrl = `https://github.com/${owner}/${repo}/blob/${actualRef}/${encodedPath}`;

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
      Logger.error(`Repository ${owner}/${repo} not accessible or empty`, error as Error);
      throw new GitHubError('Failed to load markdown files', {
        code: ErrorCodes.GITHUB_CONNECTION_FAILED,
        metadata: { owner, repo, path },
      });
    }
  }

  async getMarkdownFile({
    owner,
    repo,
    path,
    ref,
  }: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<MarkdownFile | null> {
    try {
      const actualRef = ref || (await this.getDefaultBranch(owner, repo));
      Logger.info(`Loading markdown file: ${path} (${owner}/${repo})`);

      const fileResponse = await this.throttledRequest(() =>
        this.octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref: actualRef,
        }),
      );
      const fileData = (fileResponse as any).data;

      if (Array.isArray(fileData) || !('content' in fileData)) {
        Logger.warn(`Cannot get content for ${path}`);
        return null;
      }

      const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
      const tree = parseMarkdownToTree(content, path.split('/').pop() || '');

      const markdownFile: MarkdownFile = {
        name: fileData.name,
        path: fileData.path,
        content,
        githubUrl: fileData.html_url,
        tree,
      };

      Logger.info(`Markdown file loaded: ${path} (${content.length} bytes)`);
      return markdownFile;
    } catch (error) {
      Logger.error(`Error loading file ${path}`, error as Error);
      return null;
    }
  }

  async updateMarkdownFile({
    owner,
    repo,
    path,
    content,
    message = 'Update markdown content',
  }: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message?: string;
  }): Promise<void> {
    try {
      const currentFileResponse = await this.throttledRequest(() =>
        this.octokit.rest.repos.getContent({
          owner,
          repo,
          path,
        }),
      );
      const currentFile = (currentFileResponse as any).data;

      if (Array.isArray(currentFile) || !('sha' in currentFile)) {
        throw new GitHubError('Invalid file data', {
          code: ErrorCodes.GITHUB_FILE_NOT_FOUND,
        });
      }

      await this.throttledRequest(() =>
        this.octokit.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(content).toString('base64'),
          sha: currentFile.sha,
        }),
      );

      // Invalidate cache for this file
      const cacheKeys = Array.from(this.fileContentCache.keys()).filter((key) =>
        key.startsWith(`${owner}/${repo}/${path}:`),
      );
      cacheKeys.forEach((key) => this.fileContentCache.delete(key));

      Logger.info(`Successfully updated file: ${path}`);
    } catch (error) {
      Logger.error('Failed to update file', error as Error, { owner, repo, path });
      throw new GitHubError('Failed to update file', {
        code: ErrorCodes.GITHUB_UPDATE_FAILED,
        metadata: { owner, repo, path },
      });
    }
  }

  async testConnection({
    owner,
    repo,
  }: {
    owner: string;
    repo: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      const response = await this.throttledRequest(() =>
        this.octokit.rest.repos.get({
          owner,
          repo,
        }),
      );
      const data = (response as any).data;

      const message = `Repository connection successful: ${data.full_name} (${data.description || 'No description'})`;
      Logger.info('GitHub connection test successful', { owner, repo });

      return {
        success: true,
        message,
      };
    } catch (error: unknown) {
      Logger.error('GitHub connection test failed', error as Error, { owner, repo });

      interface ErrorWithStatus {
        status?: number;
        message?: string;
      }

      const err = error as ErrorWithStatus;

      if (err.status === 404) {
        return {
          success: false,
          message: `Repository not found: ${owner}/${repo}. Please check the repository name.`,
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

  // Cache management methods
  public clearCache(): void {
    this.fileContentCache.clear();
    Logger.info('File content cache cleared');
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
