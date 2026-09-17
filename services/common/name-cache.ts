import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { anonymizationService } from 'services/anonymization/anonymization-service';
import { getDataPath } from 'services/common/data-path';

interface UserCache {
  [userId: string]: {
    name: string;
    /**
     * The raw Slack locale tag (`ko-KR`, `en-US`) from `users.info` with
     * `include_locale: true`. Two absent-ish values, deliberately distinct:
     * the key missing means we have never asked Slack (an entry written before
     * locales were cached), and `''` means we asked and Slack had nothing for
     * this user (locale is a workspace setting and can be off). The empty
     * string survives a JSON round-trip where `undefined` would not, so a
     * locale-less user costs exactly one `users.info` call, not one per lookup.
     */
    locale?: string;
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
    this.cacheDir = getDataPath('cache');
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
  private botUserIdCache = new Map<string, string>(); // bot token -> botUserId

  async getBotUserId(client: WebClient): Promise<string | null> {
    // Cache by the client's bot token: the bot user id is stable per workspace,
    // so reading the cache first avoids an auth.test network round-trip on every
    // call (previously the cache was written but never read). getUserName calls
    // this per lookup, so this is on a very hot path.
    const token = (client as unknown as { token?: string }).token;
    if (token) {
      const cached = this.botUserIdCache.get(token);
      if (cached) return cached;
    }

    try {
      const authInfo = await client.auth.test();
      const botUserId = authInfo.user_id;

      if (botUserId) {
        if (token) this.botUserIdCache.set(token, botUserId);
        return botUserId;
      }
      return null;
    } catch {
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
      const { name } = await this.refreshUser(userId, client);
      return name;
    } catch (error) {
      console.warn(`Failed to fetch user name for ${userId}:`, error);
      return cached?.name || 'Unknown User';
    }
  }

  /**
   * One `users.info` round-trip that fills both halves of the entry. Every
   * lookup asks for the locale, so a name lookup back-fills the locale for free
   * and vice versa — the language layer adds no Slack traffic of its own on a
   * warm cache.
   */
  private async refreshUser(userId: string, client: WebClient): Promise<{ name: string; locale: string }> {
    const result = await client.users.info({ user: userId, include_locale: true });
    const user = result.user as any;
    const name = user?.real_name || user?.display_name || user?.name || 'Unknown User';
    const locale = typeof user?.locale === 'string' ? user.locale : '';

    this.cache.users[userId] = {
      name,
      locale,
      lastUpdated: new Date().toISOString(),
    };
    this.saveCache();

    return { name, locale };
  }

  /**
   * The user's Slack locale tag (`ko-KR`), or undefined when Slack has none or
   * the lookup fails. Shares the entry and the 7-day TTL with `getUserName`.
   */
  async getUserLocale(userId: string, client: WebClient): Promise<string | undefined> {
    if (!userId || userId === 'undefined' || userId === 'null') {
      return undefined;
    }

    const cached = this.cache.users[userId];
    // `locale === undefined` means "never asked", which is worth one call even
    // on an otherwise fresh entry.
    if (cached && cached.locale !== undefined && !this.isExpired(cached.lastUpdated)) {
      return cached.locale || undefined;
    }

    try {
      const { locale } = await this.refreshUser(userId, client);
      return locale || undefined;
    } catch (error) {
      console.warn(`Failed to fetch user locale for ${userId}:`, error);
      return cached?.locale || undefined;
    }
  }

  /**
   * The cached Slack locale tag, without ever touching the network. For hot
   * paths (the Bolt middleware) that would rather fall through to the workspace
   * default than pay for an API call.
   */
  getCachedUserLocale(userId: string): string | undefined {
    const cached = this.cache.users[userId];
    if (!cached || this.isExpired(cached.lastUpdated)) return undefined;
    return cached.locale || undefined;
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

  /**
   * Removes a workspace's cached names on uninstall. The workspace entry and its
   * channels are keyed by workspace and dropped; user-name entries are keyed by
   * userId only (not workspace-attributable) and are left as-is.
   */
  purgeWorkspace(workspaceId: string): void {
    delete this.cache.workspaces[workspaceId];
    for (const channelId of Object.keys(this.cache.channels)) {
      if (this.cache.channels[channelId].workspaceId === workspaceId) {
        delete this.cache.channels[channelId];
      }
    }
    this.saveCache();
  }
}

// Singleton instance
export const nameCacheService = new NameCacheService();

// Convenience functions
export const getCachedUserName = nameCacheService.getUserName.bind(nameCacheService);
export const getUserLocale = nameCacheService.getUserLocale.bind(nameCacheService);
export const getCachedUserLocale = nameCacheService.getCachedUserLocale.bind(nameCacheService);
export const getCachedWorkspaceName = nameCacheService.getWorkspaceName.bind(nameCacheService);
export const getCachedChannelName = nameCacheService.getChannelName.bind(nameCacheService);
export const getAllCachedNames = nameCacheService.getAllNames.bind(nameCacheService);

export const purgeWorkspaceNames = nameCacheService.purgeWorkspace.bind(nameCacheService);

// Anonymization functions (delegated to anonymization service)
export const getAnonymizationMapping = anonymizationService.getAnonymizationMapping.bind(anonymizationService);
export const anonymizeText = anonymizationService.anonymizeText.bind(anonymizationService);
export const deAnonymizeText = anonymizationService.deAnonymizeText.bind(anonymizationService);
export const purgeWorkspaceAnonymization = anonymizationService.purgeWorkspace.bind(anonymizationService);
