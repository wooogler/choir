import fs from 'node:fs';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { withRateLimit } from 'services/slack/rate-limit-handler';
import { Logger } from 'services/common/logger';

export interface WorkspaceConfig {
  workspaceId: string;
  githubRepo?: {
    owner: string;
    repo: string;
    path: string;
    branch?: string;
  };
  qaChannel?: string;
  organizationName?: string;
  organizationDescription?: string;
  managers: string[];
  choirUsers: string[]; // Users authorized to use CHOIR (includes managers)
  loggingEnabled?: boolean; // Controls file-based logging on/off
  readOnlyFiles?: string[]; // Files that are read-only (excluded from document updates)
  markdownFiles?: Array<{
    name: string;
    path: string;
  }>;
  markdownFilesCachedAt?: Date;
  githubTokens?: {
    [userId: string]: {
      accessToken: string;
      user: {
        id: number;
        login: string;
        name: string;
        email: string;
        avatar_url: string;
      };
      connectedAt: Date;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

export class WorkspaceStore {
  private dataPath: string;
  private logger: Console;

  constructor(logger: Console = console) {
    this.dataPath = path.join(process.cwd(), 'data');
    this.logger = logger;
    this.ensureDataDirectory();
  }

  /**
   * 데이터 디렉토리 존재 확인 및 생성
   */
  private ensureDataDirectory(): void {
    try {
      if (!fs.existsSync(this.dataPath)) {
        fs.mkdirSync(this.dataPath, { recursive: true });
        this.logger.info(`Created data directory: ${this.dataPath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to create data directory: ${error}`);
    }
  }

  /**
   * 워크스페이스 설정 파일 경로 생성
   */
  private getWorkspaceConfigPath(workspaceId: string): string {
    return path.join(this.dataPath, `${workspaceId}-config.json`);
  }

  /**
   * 워크스페이스 설정 저장
   */
  public async saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
    try {
      this.ensureDataDirectory();

      config.updatedAt = new Date();
      const configPath = this.getWorkspaceConfigPath(config.workspaceId);

      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
      this.logger.info(`Saved workspace config for: ${config.workspaceId}`);
    } catch (error) {
      this.logger.error(`Failed to save workspace config: ${error}`);
      throw error;
    }
  }

  /**
   * 워크스페이스 설정 가져오기
   */
  public async getWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfig | null> {
    try {
      const configPath = this.getWorkspaceConfigPath(workspaceId);

      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configData = await fs.promises.readFile(configPath, 'utf-8');
      const config = JSON.parse(configData) as WorkspaceConfig;

      // Date 객체 복원
      config.createdAt = new Date(config.createdAt);
      config.updatedAt = new Date(config.updatedAt);
      if (config.markdownFilesCachedAt) {
        config.markdownFilesCachedAt = new Date(config.markdownFilesCachedAt);
      }
      if (config.githubTokens) {
        for (const userId in config.githubTokens) {
          config.githubTokens[userId].connectedAt = new Date(config.githubTokens[userId].connectedAt);
        }
      }

      return config;
    } catch (error) {
      this.logger.error(`Failed to load workspace config: ${error}`);
      return null;
    }
  }

  /**
   * 워크스페이스 초기 설정
   */
  public async initializeWorkspace(
    workspaceId: string,
    initialManagerId: string,
    client: WebClient,
  ): Promise<WorkspaceConfig> {
    const existingConfig = await this.getWorkspaceConfig(workspaceId);
    if (existingConfig) {
      return existingConfig;
    }

    // 워크스페이스 정보 가져오기 (rate limit 처리)
    const workspaceInfo = await withRateLimit(() => client.auth.test(), 'get workspace auth info');
    const teamInfo = await withRateLimit(() => client.team.info(), 'get team info');

    const config: WorkspaceConfig = {
      workspaceId,
      managers: [initialManagerId],
      choirUsers: [initialManagerId], // Manager is automatically a CHOIR user
      organizationName: teamInfo.team?.name || workspaceInfo.team || 'Our Organization',
      loggingEnabled: true, // Default to enabled
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.saveWorkspaceConfig(config);
    this.logger.info(`Initialized workspace: ${workspaceId}`);

    return config;
  }

  /**
   * 관리자 추가
   */
  public async addManager(workspaceId: string, userId: string, grantedBy: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) return false;

    // 'self-promotion'인 경우 권한 확인 건너뛰기
    if (grantedBy !== 'self-promotion' && !config.managers.includes(grantedBy)) {
      return false; // 권한 부여자가 관리자가 아님
    }

    if (!config.managers.includes(userId)) {
      config.managers.push(userId);

      // Ensure manager is also a CHOIR user
      if (!config.choirUsers.includes(userId)) {
        config.choirUsers.push(userId);
      }

      await this.saveWorkspaceConfig(config);
    }

    return true;
  }

  /**
   * 관리자 제거
   */
  public async removeManager(workspaceId: string, userId: string, removedBy: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) return false;

    if (!config.managers.includes(removedBy)) {
      return false; // 권한 제거자가 관리자가 아님
    }

    if (config.managers.includes(userId)) {
      config.managers = config.managers.filter((id) => id !== userId);

      // Note: We don't automatically remove from choirUsers when removing manager
      // This allows former managers to continue using CHOIR if desired

      await this.saveWorkspaceConfig(config);
    }

    return true;
  }

  /**
   * GitHub 저장소 설정
   */
  public async setGithubRepo(
    workspaceId: string,
    repoInfo: { owner: string; repo: string; path: string; branch?: string },
  ): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    config.githubRepo = repoInfo;
    await this.saveWorkspaceConfig(config);
  }

  /**
   * Q&A 채널 설정
   */
  public async setQAChannel(workspaceId: string, channelId: string): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    config.qaChannel = channelId;
    await this.saveWorkspaceConfig(config);
  }

  /**
   * 조직 이름 설정
   */
  public async setOrganizationName(workspaceId: string, name: string): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    config.organizationName = name;
    await this.saveWorkspaceConfig(config);
  }

  /**
   * 조직 설명 설정
   */
  public async setOrganizationDescription(workspaceId: string, description: string): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    config.organizationDescription = description;
    await this.saveWorkspaceConfig(config);
  }

  /**
   * 워크스페이스 제거
   */
  public async removeWorkspace(workspaceId: string): Promise<void> {
    try {
      const configPath = this.getWorkspaceConfigPath(workspaceId);
      if (fs.existsSync(configPath)) {
        await fs.promises.unlink(configPath);
        this.logger.info(`Removed workspace config: ${workspaceId}`);
      }
    } catch (error) {
      this.logger.error(`Failed to remove workspace: ${error}`);
    }
  }

  /**
   * 마크다운 파일 목록 캐시 업데이트
   */
  public async getMarkdownFilesCache(workspaceId: string): Promise<Array<{ name: string; path: string }> | null> {
    const config = await this.getWorkspaceConfig(workspaceId);
    return config?.markdownFiles || null;
  }

  public async setMarkdownFilesCache(workspaceId: string, files: Array<{ name: string; path: string }>): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    config.markdownFiles = files;
    config.markdownFilesCachedAt = new Date();
    await this.saveWorkspaceConfig(config);
  }

  /**
   * 캐시된 마크다운 파일 목록 가져오기 (Graceful Degradation 방식)
   * 캐시가 만료되어도 기존 데이터를 반환하고, 백그라운드에서 자동 새로고침
   */
  public async getCachedMarkdownFiles(workspaceId: string): Promise<Array<{ name: string; path: string }> | null> {
    const config = await this.getWorkspaceConfig(workspaceId);
    
    // 캐시가 아예 없는 경우에만 null 반환
    if (!config?.markdownFiles) {
      return null;
    }

    // 캐시가 있으면 일단 반환 (만료되어도)
    if (config.markdownFilesCachedAt) {
      const cacheAge = Date.now() - config.markdownFilesCachedAt.getTime();
      const twentyFourHours = 24 * 60 * 60 * 1000;

      // 만료되었지만 기존 데이터는 반환하고, 백그라운드에서 새로고침
      if (cacheAge > twentyFourHours) {
        Logger.info(`Markdown files cache expired for workspace ${workspaceId}, triggering background refresh`);
        // 백그라운드 새로고침 (await 하지 않음)
        this.refreshMarkdownFilesCache(workspaceId).catch(error => {
          Logger.warn('Background markdown files refresh failed:', error);
        });
      }
    }

    return config.markdownFiles;
  }

  /**
   * 백그라운드에서 마크다운 파일 캐시를 새로고침
   */
  private async refreshMarkdownFilesCache(workspaceId: string): Promise<void> {
    try {
      const config = await this.getWorkspaceConfig(workspaceId);
      if (!config?.githubRepo) {
        Logger.warn(`No GitHub repo configured for workspace ${workspaceId}, skipping cache refresh`);
        return;
      }

      // GithubService를 동적으로 import하여 순환 의존성 방지
      const GithubServiceModule = await import('services/github/github-service');
      const githubService = GithubServiceModule.default.getInstance();
      
      Logger.info(`Refreshing markdown files cache for workspace ${workspaceId} from GitHub repo ${config.githubRepo.owner}/${config.githubRepo.repo}`);

      const markdownFiles = await githubService.getAllMarkdownFiles({
        owner: config.githubRepo.owner,
        repo: config.githubRepo.repo,
        path: config.githubRepo.path || '',
        ref: config.githubRepo.branch,
        workspaceId,
      });

      const fileList = markdownFiles.map((file: any) => ({
        name: file.name,
        path: file.path,
      }));
      
      await this.setMarkdownFilesCache(workspaceId, fileList);
      Logger.info(`Successfully refreshed markdown files cache for workspace ${workspaceId}, found ${fileList.length} files`);

      // 벡터 스토어도 백그라운드에서 업데이트 (선택적)
      try {
        const { VectorStoreService } = await import('services/vector/main-service');
        const vectorStore = VectorStoreService.getInstance();
        
        // 캐시를 사용하지 않고 새로 초기화
        const success = await vectorStore.initialize(markdownFiles, false, true, workspaceId);
        if (success) {
          Logger.info(`Successfully updated vector store for workspace ${workspaceId} with ${markdownFiles.length} files`);
        }
      } catch (vectorError) {
        // 벡터 스토어 업데이트 실패는 로그만 남기고 진행
        Logger.warn(`Failed to update vector store for workspace ${workspaceId}:`, vectorError as Error);
      }
    } catch (error) {
      Logger.error(`Failed to refresh markdown files cache for workspace ${workspaceId}:`, error as Error);
    }
  }

  /**
   * CHOIR 사용자 목록 가져오기
   */
  public async getCHOIRUsers(workspaceId: string): Promise<string[]> {
    const config = await this.getWorkspaceConfig(workspaceId);
    return config?.choirUsers || [];
  }

  /**
   * CHOIR 사용자 설정 (기존 목록 대체)
   */
  public async setCHOIRUsers(workspaceId: string, userIds: string[]): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) return false;

    // Ensure all managers are included in CHOIR users
    const allCHOIRUsers = [...new Set([...config.managers, ...userIds])];

    config.choirUsers = allCHOIRUsers;
    await this.saveWorkspaceConfig(config);
    return true;
  }

  /**
   * CHOIR 사용자 추가
   */
  public async addCHOIRUser(workspaceId: string, userId: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) return false;

    if (!config.choirUsers.includes(userId)) {
      config.choirUsers.push(userId);
      await this.saveWorkspaceConfig(config);
    }
    return true;
  }

  /**
   * CHOIR 사용자 제거 (관리자는 제거할 수 없음)
   */
  public async removeCHOIRUser(workspaceId: string, userId: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) return false;

    // 관리자는 CHOIR 사용자에서 제거할 수 없음
    if (config.managers.includes(userId)) {
      return false;
    }

    config.choirUsers = config.choirUsers.filter((id) => id !== userId);
    await this.saveWorkspaceConfig(config);
    return true;
  }

  /**
   * 사용자의 GitHub 토큰 저장
   */
  public async setUserGithubToken(
    workspaceId: string,
    userId: string,
    tokenData: {
      accessToken: string;
      user: {
        id: number;
        login: string;
        name: string;
        email: string;
        avatar_url: string;
      };
    },
  ): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    if (!config.githubTokens) {
      config.githubTokens = {};
    }

    config.githubTokens[userId] = {
      ...tokenData,
      connectedAt: new Date(),
    };

    await this.saveWorkspaceConfig(config);
    this.logger.info(`Saved GitHub token for user ${userId} in workspace ${workspaceId}`);
  }

  /**
   * 사용자의 GitHub 토큰 가져오기
   */
  public async getUserGithubToken(workspaceId: string, userId: string): Promise<string | null> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config?.githubTokens?.[userId]) {
      return null;
    }

    return config.githubTokens[userId].accessToken;
  }

  /**
   * 사용자의 GitHub 정보 가져오기
   */
  public async getUserGithubInfo(
    workspaceId: string,
    userId: string,
  ): Promise<{
    accessToken: string;
    user: {
      id: number;
      login: string;
      name: string;
      email: string;
      avatar_url: string;
    };
    connectedAt: Date;
  } | null> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config?.githubTokens?.[userId]) {
      return null;
    }

    const tokenData = config.githubTokens[userId];
    return {
      ...tokenData,
      connectedAt: new Date(tokenData.connectedAt),
    };
  }

  /**
   * 사용자의 GitHub 토큰 제거
   */
  public async removeUserGithubToken(workspaceId: string, userId: string): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config?.githubTokens?.[userId]) {
      return;
    }

    delete config.githubTokens[userId];
    await this.saveWorkspaceConfig(config);
    this.logger.info(`Removed GitHub token for user ${userId} in workspace ${workspaceId}`);
  }

  /**
   * 워크스페이스의 모든 GitHub 연결된 사용자 가져오기
   */
  public async getGithubConnectedUsers(workspaceId: string): Promise<string[]> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config?.githubTokens) {
      return [];
    }

    return Object.keys(config.githubTokens);
  }

  /**
   * 로깅 설정 토글
   */
  public async setLoggingEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    config.loggingEnabled = enabled;
    await this.saveWorkspaceConfig(config);
  }

  /**
   * 로깅 설정 가져오기
   */
  public async getLoggingEnabled(workspaceId: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    return config?.loggingEnabled ?? true; // Default to enabled if not set
  }

  /**
   * 모든 워크스페이스 설정 가져오기
   */
  public async getAllWorkspaceConfigs(): Promise<WorkspaceConfig[]> {
    try {
      const files = await fs.promises.readdir(this.dataPath);
      const configFiles = files.filter((file) => file.endsWith('-config.json'));

      const configs: WorkspaceConfig[] = [];

      for (const file of configFiles) {
        const workspaceId = file.replace('-config.json', '');
        const config = await this.getWorkspaceConfig(workspaceId);
        if (config) {
          configs.push(config);
        }
      }

      return configs;
    } catch (error) {
      this.logger.error(`Failed to get all workspace configs: ${error}`);
      return [];
    }
  }

  /**
   * 읽기 전용 파일 목록 가져오기
   */
  public async getReadOnlyFiles(workspaceId: string): Promise<string[]> {
    const config = await this.getWorkspaceConfig(workspaceId);
    return config?.readOnlyFiles || [];
  }

  /**
   * 읽기 전용 파일 목록 설정 (기존 목록 대체)
   */
  public async setReadOnlyFiles(workspaceId: string, fileNames: string[]): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) return false;

    config.readOnlyFiles = fileNames;
    await this.saveWorkspaceConfig(config);
    return true;
  }

  /**
   * 읽기 전용 파일 추가
   */
  public async addReadOnlyFile(workspaceId: string, fileName: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config) return false;

    if (!config.readOnlyFiles) {
      config.readOnlyFiles = [];
    }

    if (!config.readOnlyFiles.includes(fileName)) {
      config.readOnlyFiles.push(fileName);
      await this.saveWorkspaceConfig(config);
    }
    return true;
  }

  /**
   * 읽기 전용 파일 제거
   */
  public async removeReadOnlyFile(workspaceId: string, fileName: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config || !config.readOnlyFiles) return false;

    config.readOnlyFiles = config.readOnlyFiles.filter((name) => name !== fileName);
    await this.saveWorkspaceConfig(config);
    return true;
  }

  /**
   * 파일이 읽기 전용인지 확인
   */
  public async isReadOnlyFile(workspaceId: string, fileName: string): Promise<boolean> {
    const config = await this.getWorkspaceConfig(workspaceId);
    return config?.readOnlyFiles?.includes(fileName) || false;
  }

  /**
   * 쓰기 가능한 파일 목록 가져오기 (전체 파일 목록에서 읽기 전용 파일 제외)
   */
  public async getWritableFiles(workspaceId: string): Promise<Array<{ name: string; path: string }>> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config?.markdownFiles) return [];

    const readOnlyFiles = config.readOnlyFiles || [];
    return config.markdownFiles.filter((file) => !readOnlyFiles.includes(file.name));
  }
}
