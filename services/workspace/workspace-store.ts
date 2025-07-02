import fs from 'fs';
import path from 'path';
import type { WebClient } from '@slack/web-api';

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
  markdownFiles?: Array<{
    name: string;
    path: string;
  }>;
  markdownFilesCachedAt?: Date;
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

    // 워크스페이스 정보 가져오기
    const workspaceInfo = await client.auth.test();
    const teamInfo = await client.team.info();

    const config: WorkspaceConfig = {
      workspaceId,
      managers: [initialManagerId],
      organizationName: teamInfo.team?.name || workspaceInfo.team || 'Our Organization',
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

    if (!config.managers.includes(grantedBy)) {
      return false; // 권한 부여자가 관리자가 아님
    }

    if (!config.managers.includes(userId)) {
      config.managers.push(userId);
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
   * 캐시된 마크다운 파일 목록 가져오기
   */
  public async getCachedMarkdownFiles(workspaceId: string): Promise<Array<{ name: string; path: string }> | null> {
    const config = await this.getWorkspaceConfig(workspaceId);
    if (!config?.markdownFiles || !config.markdownFilesCachedAt) {
      return null;
    }

    // 캐시가 24시간 이상 오래된 경우 무효화
    const cacheAge = Date.now() - config.markdownFilesCachedAt.getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (cacheAge > twentyFourHours) {
      return null;
    }

    return config.markdownFiles;
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
}
