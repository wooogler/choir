import * as fs from 'fs';
import * as path from 'path';
import type { WebClient } from '@slack/web-api';
import { anonymizationService } from 'services/anonymization/anonymization-service';

interface UserCache {
  [userId: string]: {
    name: string;
    lastUpdated: string;
  };
}

interface WorkspaceCache {
  [workspaceId: string]: {
    name: string;
    lastUpdated: string;
  };
}

interface ChannelCache {
  [channelId: string]: {
    name: string;
    workspaceId: string;
    lastUpdated: string;
  };
}


interface NameCacheData {
  users: UserCache;
  workspaces: WorkspaceCache;
  channels: ChannelCache;
}

class NameCacheService {
  private cacheDir: string;
  private cacheFile: string;
  private cache: NameCacheData;
  private readonly CACHE_EXPIRY_DAYS = 7; // Cache expires after 7 days

  constructor() {
    this.cacheDir = path.join(process.cwd(), 'data', 'cache');
    this.cacheFile = path.join(this.cacheDir, 'name-mappings.json');
    this.cache = {
      users: {},
      workspaces: {},
      channels: {},
    };
    this.ensureCacheDirectory();
    this.loadCache();
  }

  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const cacheData = fs.readFileSync(this.cacheFile, 'utf-8').trim();

        // Check if file is empty or contains only whitespace
        if (!cacheData) {
          console.info('Name cache file is empty, initializing with default structure');
          this.initializeEmptyCache();
          return;
        }

        this.cache = JSON.parse(cacheData);
      } else {
        console.info('Name cache file does not exist, creating new cache');
        this.initializeEmptyCache();
      }
    } catch (error) {
      console.warn('Failed to load name cache, starting with empty cache:', error);
      this.initializeEmptyCache();
    }
  }

  private initializeEmptyCache(): void {
    this.cache = {
      users: {},
      workspaces: {},
      channels: {},
    };
    this.saveCache(); // Save the initial empty structure
  }

  private saveCache(): void {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error('Failed to save name cache:', error);
    }
  }

  private isExpired(lastUpdated: string): boolean {
    const lastUpdate = new Date(lastUpdated);
    const now = new Date();
    const daysDiff = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
    return daysDiff > this.CACHE_EXPIRY_DAYS;
  }

  /**
   * Get bot user ID for current workspace
   */
  private botUserIdCache = new Map<string, string>(); // teamId -> botUserId

  async getBotUserId(client: WebClient): Promise<string | null> {
    try {
      const authInfo = await client.auth.test();
      const teamId = authInfo.team_id;
      const botUserId = authInfo.user_id;
      
      if (teamId && botUserId) {
        this.botUserIdCache.set(teamId, botUserId);
        return botUserId;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get user name with caching
   */
  async getUserName(userId: string, client: WebClient): Promise<string> {
    // Handle invalid user IDs
    if (!userId || userId === 'undefined' || userId === 'null') {
      return 'Unknown User';
    }

    // Check if this is the bot user
    const botUserId = await this.getBotUserId(client);
    if (userId === botUserId) {
      return 'CHOIR';
    }

    // Check cache first
    const cached = this.cache.users[userId];
    if (cached && !this.isExpired(cached.lastUpdated)) {
      return cached.name;
    }

    // Fetch from API
    try {
      const result = await client.users.info({ user: userId });
      const user = result.user as any;
      const userName = user?.real_name || user?.display_name || user?.name || 'Unknown User';

      // Update cache
      this.cache.users[userId] = {
        name: userName,
        lastUpdated: new Date().toISOString(),
      };
      this.saveCache();

      return userName;
    } catch (error) {
      console.warn(`Failed to fetch user name for ${userId}:`, error);
      return cached?.name || 'Unknown User';
    }
  }

  /**
   * Get workspace name with caching
   */
  async getWorkspaceName(workspaceId: string, client: WebClient): Promise<string> {
    // Check cache first
    const cached = this.cache.workspaces[workspaceId];
    if (cached && !this.isExpired(cached.lastUpdated)) {
      return cached.name;
    }

    // Fetch from API
    try {
      const teamInfo = await client.team.info();
      const workspaceName = teamInfo.team?.name || 'Unknown Workspace';

      // Update cache
      this.cache.workspaces[workspaceId] = {
        name: workspaceName,
        lastUpdated: new Date().toISOString(),
      };
      this.saveCache();

      return workspaceName;
    } catch (error) {
      console.warn(`Failed to fetch workspace name for ${workspaceId}:`, error);
      return cached?.name || 'Unknown Workspace';
    }
  }

  /**
   * Get channel name with caching
   */
  async getChannelName(channelId: string, workspaceId: string, client: WebClient): Promise<string> {
    // Special handling for DM channels
    if (channelId === 'dm' || channelId === 'modal') {
      return channelId;
    }

    // Handle DM channels (channel IDs starting with 'D')
    if (channelId.startsWith('D')) {
      // Check cache first for DM channels
      const cached = this.cache.channels[channelId];
      if (cached && !this.isExpired(cached.lastUpdated)) {
        return cached.name;
      }

      // For DM channels, return a simple "DM" name
      const dmName = 'DM';

      // Update cache
      this.cache.channels[channelId] = {
        name: dmName,
        workspaceId,
        lastUpdated: new Date().toISOString(),
      };
      this.saveCache();

      return dmName;
    }

    // Check cache first for regular channels
    const cached = this.cache.channels[channelId];
    if (cached && !this.isExpired(cached.lastUpdated)) {
      // Special case: If a DM channel is cached as "Unknown Channel", re-validate it
      if (channelId.startsWith('D') && cached.name === 'Unknown Channel') {
        // Force refresh for DM channels that were previously unknown
      } else {
        return cached.name;
      }
    }

    // Fetch from API for regular channels
    try {
      const result = await client.conversations.info({ channel: channelId });
      const channelName = result.channel?.name || 'Unknown Channel';

      // Update cache
      this.cache.channels[channelId] = {
        name: channelName,
        workspaceId,
        lastUpdated: new Date().toISOString(),
      };
      this.saveCache();

      return channelName;
    } catch (error) {
      console.warn(`Failed to fetch channel name for ${channelId}:`, error);

      // Check if this might be a group DM that failed to fetch
      // Group DMs sometimes have C-prefixed IDs but fail conversations.info calls
      if (error && typeof error === 'object' && 'data' in error) {
        const slackError = error as any;
        if (slackError.data?.error === 'channel_not_found' || slackError.data?.error === 'missing_scope') {
          // This might be a group DM with C-prefix that we can't access
          const dmName = 'DM';

          // Update cache with DM name
          this.cache.channels[channelId] = {
            name: dmName,
            workspaceId,
            lastUpdated: new Date().toISOString(),
          };
          this.saveCache();

          return dmName;
        }
      }

      return cached?.name || 'Unknown Channel';
    }
  }

  /**
   * Get all names at once for efficient logging
   */
  async getAllNames(
    userId: string,
    workspaceId: string,
    channelId: string,
    client: WebClient,
  ): Promise<{
    userName: string;
    workspaceName: string;
    channelName: string;
  }> {
    const [userName, workspaceName, channelName] = await Promise.all([
      this.getUserName(userId, client),
      this.getWorkspaceName(workspaceId, client),
      this.getChannelName(channelId, workspaceId, client),
    ]);

    return {
      userName,
      workspaceName,
      channelName,
    };
  }

  /**
   * Clear expired cache entries
   */
  clearExpiredCache(): void {
    // Clear expired users
    for (const userId in this.cache.users) {
      if (this.isExpired(this.cache.users[userId].lastUpdated)) {
        delete this.cache.users[userId];
      }
    }

    // Clear expired workspaces
    for (const workspaceId in this.cache.workspaces) {
      if (this.isExpired(this.cache.workspaces[workspaceId].lastUpdated)) {
        delete this.cache.workspaces[workspaceId];
      }
    }

    // Clear expired channels
    for (const channelId in this.cache.channels) {
      if (this.isExpired(this.cache.channels[channelId].lastUpdated)) {
        delete this.cache.channels[channelId];
      }
    }

    this.saveCache();
  }


  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalUsers: number;
    totalWorkspaces: number;
    totalChannels: number;
    cacheFile: string;
  } {
    return {
      totalUsers: Object.keys(this.cache.users).length,
      totalWorkspaces: Object.keys(this.cache.workspaces).length,
      totalChannels: Object.keys(this.cache.channels).length,
      cacheFile: this.cacheFile,
    };
  }
}

// Singleton instance
export const nameCacheService = new NameCacheService();

// Convenience functions
export const getCachedUserName = nameCacheService.getUserName.bind(nameCacheService);
export const getCachedWorkspaceName = nameCacheService.getWorkspaceName.bind(nameCacheService);
export const getCachedChannelName = nameCacheService.getChannelName.bind(nameCacheService);
export const getAllCachedNames = nameCacheService.getAllNames.bind(nameCacheService);

// Anonymization functions (delegated to anonymization service)
export const getAnonymizationMapping = anonymizationService.getAnonymizationMapping.bind(anonymizationService);
export const anonymizeText = anonymizationService.anonymizeText.bind(anonymizationService);
export const deAnonymizeText = anonymizationService.deAnonymizeText.bind(anonymizationService);
