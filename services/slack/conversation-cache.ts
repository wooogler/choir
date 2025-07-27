import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import {
  type ConversationHistoryOptions,
  type SlackMessage,
  getFilteredConversationHistory,
} from './conversation-history';

interface CacheEntry {
  messages: SlackMessage[];
  timestamp: number;
  ttl: number;
}

export class ConversationCache {
  private static instance: ConversationCache | null = null;
  private cache = new Map<string, CacheEntry>();
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {
    // Start cleanup interval every 2 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupExpiredEntries();
      },
      2 * 60 * 1000,
    );
  }

  static getInstance(): ConversationCache {
    if (!ConversationCache.instance) {
      ConversationCache.instance = new ConversationCache();
    }
    return ConversationCache.instance;
  }

  private generateCacheKey(
    channelId: string,
    threadTs: string | undefined,
    choirUsers: string[],
    options: ConversationHistoryOptions,
  ): string {
    // Simple string-based cache key like session-store
    const choirUsersKey = [...choirUsers].sort().join(',');
    const timeLimit = options.timeLimit || (threadTs ? 1440 : 5);
    const messageLimit = options.messageLimit || (threadTs ? 20 : 10);
    const maxResults = options.maxResults || (threadTs ? 15 : 5);

    return `${channelId}_${threadTs || 'main'}_${timeLimit}_${messageLimit}_${maxResults}_${choirUsersKey}`;
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      Logger.info(
        `ConversationCache: Cleaned up ${cleanedCount} expired entries. Current cache size: ${this.cache.size}`,
      );
    }
  }

  async getOrFetchHistory(
    client: WebClient,
    event: any,
    choirUsers: string[],
    options: ConversationHistoryOptions = {},
  ): Promise<SlackMessage[]> {
    const cacheKey = this.generateCacheKey(event.channel, event.thread_ts, choirUsers, options);
    const now = Date.now();

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.timestamp < cached.ttl) {
      Logger.info(
        `ConversationCache: Cache HIT for channel ${event.channel}${event.thread_ts ? ` thread ${event.thread_ts}` : ''}`,
      );
      return cached.messages;
    }

    // Cache miss - fetch from API
    Logger.info(
      `ConversationCache: Cache MISS for channel ${event.channel}${event.thread_ts ? ` thread ${event.thread_ts}` : ''} - fetching from API`,
    );

    try {
      const messages = await getFilteredConversationHistory(client, event, choirUsers, options);

      // Store in cache
      this.cache.set(cacheKey, {
        messages,
        timestamp: now,
        ttl: this.DEFAULT_TTL,
      });

      Logger.info(
        `ConversationCache: Cached ${messages.length} messages for channel ${event.channel}. Cache size: ${this.cache.size}`,
      );
      return messages;
    } catch (error) {
      Logger.error('ConversationCache: Failed to fetch conversation history', error as Error, {
        channel: event.channel,
        thread_ts: event.thread_ts,
        cacheKey,
      });
      throw error;
    }
  }

  // Add a new message to existing cache entries (more efficient than invalidation)
  addMessageToCache(channelId: string, threadTs: string | undefined, message: SlackMessage): void {
    let updatedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      // Find cache entries for this channel/thread
      const shouldUpdate =
        key.startsWith(`${channelId}_`) && (threadTs ? key.includes(`_${threadTs}_`) : key.includes('_main_'));

      if (shouldUpdate) {
        // Add message to the cached messages array
        const updatedMessages = [...entry.messages, message];

        // Extract maxResults from cache key to maintain limit
        // Key format: channelId_threadTs_timeLimit_messageLimit_maxResults_choirUsersKey
        const keyParts = key.split('_');
        const maxResults = keyParts.length >= 5 ? Number.parseInt(keyParts[4]) : 5;

        // Keep only the last maxResults messages to maintain the limit
        const limitedMessages = updatedMessages.slice(-maxResults);

        // Update the cache entry with new messages
        this.cache.set(key, {
          ...entry,
          messages: limitedMessages,
          timestamp: Date.now(), // Update timestamp to reset TTL
        });

        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      Logger.info(
        `ConversationCache: Added message to ${updatedCount} cache entries for channel ${channelId}${threadTs ? ` thread ${threadTs}` : ''}`,
      );
    }
  }

  // Invalidate cache for a specific channel (useful when new messages are posted)
  invalidateChannel(channelId: string, threadTs?: string): void {
    let invalidatedCount = 0;

    for (const [key] of this.cache.entries()) {
      // Simple string matching since our key format is predictable
      const shouldInvalidate = key.startsWith(`${channelId}_`) || (threadTs && key.includes(`_${threadTs}_`));

      if (shouldInvalidate) {
        this.cache.delete(key);
        invalidatedCount++;
      }
    }

    if (invalidatedCount > 0) {
      Logger.info(
        `ConversationCache: Invalidated ${invalidatedCount} cache entries for channel ${channelId}${threadTs ? ` thread ${threadTs}` : ''}`,
      );
    }
  }

  // Get cache statistics for monitoring
  getStats(): { size: number; hitRate?: number } {
    return {
      size: this.cache.size,
      // TODO: Implement hit rate tracking if needed
    };
  }

  // Clear all cache (for testing or emergency purposes)
  clearAll(): void {
    const size = this.cache.size;
    this.cache.clear();
    Logger.info(`ConversationCache: Cleared all cache entries (${size} entries)`);
  }

  // Cleanup resources
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
    ConversationCache.instance = null;
  }
}
