import { Logger } from 'services/common/logger';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  permissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    triage: boolean;
    pull: boolean;
  };
  updated_at: string;
  markdownStats?: {
    markdownFiles: number;
    totalFiles: number;
    markdownRatio: number;
  };
}

export class GitHubOAuthDeviceFlow {
  private static instance: GitHubOAuthDeviceFlow;
  private clientId: string;
  private clientSecret: string;
  private scopes: string[];

  private constructor() {
    this.clientId = process.env.GITHUB_OAUTH_CLIENT_ID || '';
    this.clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET || '';
    this.scopes = ['repo', 'read:user', 'user:email'];

    if (!this.clientId || !this.clientSecret) {
      throw new Error('GitHub OAuth credentials not configured');
    }
  }

  static getInstance(): GitHubOAuthDeviceFlow {
    if (!GitHubOAuthDeviceFlow.instance) {
      GitHubOAuthDeviceFlow.instance = new GitHubOAuthDeviceFlow();
    }
    return GitHubOAuthDeviceFlow.instance;
  }

  /**
   * Step 1: Request device code from GitHub
   */
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    try {
      const response = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          scope: this.scopes.join(' '),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      Logger.info('Device code requested successfully', {
        user_code: data.user_code,
        expires_in: data.expires_in,
      });

      return data;
    } catch (error) {
      Logger.error('Failed to request device code:', error as Error);
      throw error;
    }
  }

  /**
   * Step 2: Poll for access token
   */
  async pollForAccessToken(deviceCode: string, interval = 5): Promise<AccessTokenResponse> {
    const maxAttempts = 120; // 10 minutes max (120 * 5 seconds)
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const response = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: this.clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });

        const data = await response.json();

        if (data.access_token) {
          Logger.info('Access token obtained successfully');
          return data;
        }

        if (data.error === 'authorization_pending') {
          // User hasn't completed authorization yet, continue polling
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, interval * 1000));
          continue;
        }

        if (data.error === 'slow_down') {
          // GitHub is asking us to slow down
          interval += 5;
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, interval * 1000));
          continue;
        }

        if (data.error === 'expired_token') {
          throw new Error('The device code has expired. Please start the process again.');
        }

        if (data.error === 'access_denied') {
          throw new Error('The user denied the authorization request.');
        }

        throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        Logger.error('Error polling for access token:', error as Error);
        throw new Error('Failed to poll for access token');
      }
    }

    throw new Error('Polling timeout. The authorization process took too long.');
  }

  /**
   * Get user information using access token
   */
  async getUserInfo(accessToken: string): Promise<GitHubUser> {
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} ${errorText}`);
      }

      const userData = await response.json();

      // Get primary email if not public
      let email = userData.email;
      if (!email) {
        const emailResponse = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `token ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        });

        if (emailResponse.ok) {
          const emails = await emailResponse.json();
          const primaryEmail = emails.find((e: any) => e.primary);
          email = primaryEmail?.email || null;
        }
      }

      return {
        id: userData.id,
        login: userData.login,
        name: userData.name,
        email,
        avatar_url: userData.avatar_url,
      };
    } catch (error) {
      Logger.error('Failed to get user info:', error as Error);
      throw error;
    }
  }

  /**
   * Get user's repositories
   */
  async getUserRepositories(
    accessToken: string,
    options: {
      type?: 'all' | 'owner' | 'member';
      sort?: 'created' | 'updated' | 'pushed' | 'full_name';
      direction?: 'asc' | 'desc';
      per_page?: number;
      page?: number;
    } = {},
  ): Promise<GitHubRepository[]> {
    try {
      const { type = 'all', sort = 'updated', direction = 'desc', per_page = 100, page = 1 } = options;

      const url = `https://api.github.com/user/repos?type=${type}&sort=${sort}&direction=${direction}&per_page=${per_page}&page=${page}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `token ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} ${errorText}`);
      }

      const repositories = await response.json();
      Logger.info(`Retrieved ${repositories.length} repositories for user`);

      return repositories;
    } catch (error) {
      Logger.error('Failed to get user repositories:', error as Error);
      throw error;
    }
  }

  private async getRepositoryMarkdownStats(
    accessToken: string,
    repository: GitHubRepository,
  ): Promise<{ markdownFiles: number; totalFiles: number; markdownRatio: number }> {
    try {
      const treeUrl = `https://api.github.com/repos/${repository.owner.login}/${repository.name}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`;
      const response = await fetch(treeUrl, {
        headers: {
          Authorization: `token ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!response.ok) {
        // Empty repositories or repos without a readable default branch can legitimately fail here.
        Logger.warn(`Failed to inspect repository tree for markdown stats: ${repository.full_name}`, {
          status: response.status,
        });
        return {
          markdownFiles: 0,
          totalFiles: 0,
          markdownRatio: 0,
        };
      }

      const treeData = await response.json();
      const treeItems = Array.isArray(treeData?.tree) ? treeData.tree : [];
      const blobItems = treeItems.filter((item: any) => item?.type === 'blob' && typeof item.path === 'string');
      const markdownFiles = blobItems.filter((item: any) => item.path.toLowerCase().endsWith('.md')).length;
      const totalFiles = blobItems.length;

      return {
        markdownFiles,
        totalFiles,
        markdownRatio: totalFiles > 0 ? markdownFiles / totalFiles : 0,
      };
    } catch (error) {
      Logger.warn(`Failed to inspect repository tree for ${repository.full_name}`, error as Error);
      return {
        markdownFiles: 0,
        totalFiles: 0,
        markdownRatio: 0,
      };
    }
  }

  /**
   * Get repositories with markdown files
   */
  async getRepositoriesWithMarkdown(accessToken: string): Promise<GitHubRepository[]> {
    try {
      const repositories = await this.getUserRepositories(accessToken, {
        type: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      });

      // Filter repositories that user has push access to
      const writableRepos = repositories.filter(
        (repo) => repo.permissions && (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain),
      );

      Logger.info(`Found ${writableRepos.length} writable repositories out of ${repositories.length} total`);

      const publicWritableRepos = writableRepos.filter((repo) => !repo.private);
      const inspectedRepositories: GitHubRepository[] = [];
      const concurrency = 5;

      for (let index = 0; index < publicWritableRepos.length; index += concurrency) {
        const batch = publicWritableRepos.slice(index, index + concurrency);
        const batchResults = await Promise.all(
          batch.map(async (repo) => {
            const markdownStats = await this.getRepositoryMarkdownStats(accessToken, repo);
            return {
              ...repo,
              markdownStats,
            };
          }),
        );

        inspectedRepositories.push(...batchResults);
      }

      const repositoriesWithMarkdown = inspectedRepositories
        .filter((repo) => (repo.markdownStats?.markdownFiles || 0) > 0)
        .sort((left, right) => {
          const leftMarkdownFiles = left.markdownStats?.markdownFiles || 0;
          const rightMarkdownFiles = right.markdownStats?.markdownFiles || 0;
          if (rightMarkdownFiles !== leftMarkdownFiles) {
            return rightMarkdownFiles - leftMarkdownFiles;
          }

          const leftRatio = left.markdownStats?.markdownRatio || 0;
          const rightRatio = right.markdownStats?.markdownRatio || 0;
          if (rightRatio !== leftRatio) {
            return rightRatio - leftRatio;
          }

          return right.updated_at.localeCompare(left.updated_at);
        });

      Logger.info(
        `Found ${repositoriesWithMarkdown.length} public writable repositories with markdown files out of ${publicWritableRepos.length} public writable repositories`,
      );
      return repositoriesWithMarkdown;
    } catch (error) {
      Logger.error('Failed to get repositories with markdown:', error as Error);
      throw error;
    }
  }

  /**
   * Search user's repositories by name
   */
  async searchUserRepositories(accessToken: string, query: string): Promise<GitHubRepository[]> {
    try {
      const response = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+user:${encodeURIComponent(query)}`,
        {
          headers: {
            Authorization: `token ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      return data.items || [];
    } catch (error) {
      Logger.error('Failed to search user repositories:', error as Error);
      throw error;
    }
  }

  /**
   * Complete device flow: get device code, poll for token, and get user info
   */
  async completeDeviceFlow(): Promise<{
    accessToken: string;
    user: GitHubUser;
    deviceCode: DeviceCodeResponse;
  }> {
    const deviceCode = await this.requestDeviceCode();
    const tokenResponse = await this.pollForAccessToken(deviceCode.device_code, deviceCode.interval);
    const user = await this.getUserInfo(tokenResponse.access_token);

    return {
      accessToken: tokenResponse.access_token,
      user,
      deviceCode,
    };
  }
}
