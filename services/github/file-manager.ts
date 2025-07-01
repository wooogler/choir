import { Octokit } from 'octokit';
import { ErrorCodes, GitHubError } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import { type DocumentTree, parseMarkdownToTree } from 'services/document';

export interface MarkdownFile {
  name: string;
  path: string;
  content: string;
  githubUrl: string;
  tree: DocumentTree;
}

export class GitHubFileManager {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token || process.env.GITHUB_TOKEN,
    });
  }

  private async getDefaultBranch(owner: string, repo: string): Promise<string> {
    try {
      const { data } = await this.octokit.rest.repos.get({
        owner,
        repo,
      });
      return data.default_branch;
    } catch (error) {
      Logger.warn(`Failed to get default branch for ${owner}/${repo}, using 'main'`, error as Error);
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
      const actualRef = ref || await this.getDefaultBranch(owner, repo);
      const allMarkdownFiles: MarkdownFile[] = [];

      const exploreDirectory = async (dirPath: string): Promise<void> => {
        try {
          const { data: contents } = await this.octokit.rest.repos.getContent({
            owner,
            repo,
            path: dirPath,
            ref: actualRef,
          });

          if (!Array.isArray(contents)) {
            Logger.debug(`${dirPath} is not a directory`);
            return;
          }

          for (const item of contents) {
            if (item.type === 'dir') {
              await exploreDirectory(item.path);
            } else if (item.type === 'file' && item.name.endsWith('.md')) {
              try {
                const { data: fileData } = await this.octokit.rest.repos.getContent({
                  owner,
                  repo,
                  path: item.path,
                  ref: actualRef,
                });

                if (Array.isArray(fileData) || !('content' in fileData)) {
                  Logger.warn(`Cannot get content for ${item.path}`);
                  continue;
                }

                const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
                const tree = parseMarkdownToTree(content, item.name);

                allMarkdownFiles.push({
                  name: item.name,
                  path: item.path,
                  content,
                  githubUrl: item.html_url,
                  tree,
                });

                Logger.info(`Loaded markdown file: ${item.path}`);
              } catch (fileError) {
                Logger.error(`Error loading file ${item.path}`, fileError as Error);
              }
            }
          }
        } catch (dirError) {
          Logger.error(`Error exploring directory ${dirPath}`, dirError as Error);
        }
      };

      await exploreDirectory(path);
      Logger.info(`Loaded ${allMarkdownFiles.length} markdown files total`);
      return allMarkdownFiles;
    } catch (error) {
      Logger.error('Error loading markdown files', error as Error);
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
      const actualRef = ref || await this.getDefaultBranch(owner, repo);
      Logger.info(`Loading markdown file: ${path} (${owner}/${repo})`);

      const { data: fileData } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: actualRef,
      });

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
      const { data: currentFile } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });

      if (Array.isArray(currentFile) || !('sha' in currentFile)) {
        throw new GitHubError('Invalid file data', {
          code: ErrorCodes.GITHUB_FILE_NOT_FOUND,
        });
      }

      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
        sha: currentFile.sha,
      });

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
      const { data } = await this.octokit.rest.repos.get({
        owner,
        repo,
      });

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
}
