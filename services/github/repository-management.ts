import { Logger } from 'services/common/logger';
import { WorkspaceStore } from '../workspace/workspace-store';

const workspaceStore = new WorkspaceStore();

interface GithubRepoInfo {
  owner: string;
  repo: string;
  path: string;
  url: string;
  branch?: string;
}

/**
 * GitHub 저장소 정보를 저장합니다.
 */
export async function storeGithubRepo(workspaceId: string, repoInfo: GithubRepoInfo): Promise<void> {
  try {
    await workspaceStore.setGithubRepo(workspaceId, repoInfo);
    Logger.info('GitHub repository stored successfully', { workspaceId, repoInfo });
  } catch (error) {
    Logger.error('Error storing GitHub repository', error as Error, { workspaceId, repoInfo });
    throw error;
  }
}

/**
 * GitHub 저장소 정보를 가져옵니다.
 */
export async function getGithubRepo(workspaceId: string): Promise<GithubRepoInfo | undefined> {
  try {
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    if (!config?.githubRepo) return undefined;

    return {
      ...config.githubRepo,
      url: `https://github.com/${config.githubRepo.owner}/${config.githubRepo.repo}`,
    };
  } catch (error) {
    Logger.error('Error getting GitHub repository', error as Error, { workspaceId });
    return undefined;
  }
}

/**
 * GitHub 저장소 URL을 파싱하여 owner, repo, path 정보를 추출합니다.
 */
export function parseGithubUrl(url: string): GithubRepoInfo | null {
  try {
    const urlObj = new URL(url);

    if (urlObj.hostname !== 'github.com') {
      return null;
    }

    const pathSegments = urlObj.pathname.split('/').filter((segment) => segment);

    if (pathSegments.length < 2) {
      return null;
    }

    const owner = pathSegments[0];
    const repo = pathSegments[1];

    let path = '';
    let branch = undefined;

    if (pathSegments.length > 3 && pathSegments[2] === 'tree') {
      branch = pathSegments[3];
      path = pathSegments.slice(4).join('/');
    }

    return {
      owner,
      repo,
      path,
      url,
      branch,
    };
  } catch (error) {
    Logger.error('Error parsing GitHub URL', error as Error, { url });
    return null;
  }
}
