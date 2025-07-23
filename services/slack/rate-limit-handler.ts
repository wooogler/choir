import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';

export interface RateLimitError extends Error {
  code?: string;
  data?: {
    retryAfter?: number;
  };
}

export function isRateLimitError(error: any): error is RateLimitError {
  return error?.code === 'slack_webapi_platform_error' && error?.data?.error === 'rate_limited';
}

export async function withRateLimit<T>(operation: () => Promise<T>, description: string, maxRetries = 3): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (isRateLimitError(error)) {
        const retryAfter = error.data?.retryAfter || 60; // Default to 60 seconds
        Logger.warn(
          `Rate limit hit for ${description}. Attempt ${attempt}/${maxRetries}. Retrying in ${retryAfter} seconds...`,
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
      }

      // For non-rate-limit errors or final attempt, rethrow
      throw error;
    }
  }

  throw lastError!;
}

export async function safeSlackCall<T>(
  client: WebClient,
  operation: () => Promise<T>,
  description: string,
  fallbackMessage?: string,
): Promise<T | null> {
  try {
    return await withRateLimit(operation, description);
  } catch (error) {
    if (isRateLimitError(error)) {
      Logger.error(`Rate limit exceeded for ${description} after retries. Operation failed.`, error as Error);

      if (fallbackMessage) {
        try {
          // Try to send a simple message about the rate limit
          await client.chat.postMessage({
            channel: 'general', // This might need to be parameterized
            text: fallbackMessage,
          });
        } catch (fallbackError) {
          Logger.error('Failed to send rate limit fallback message:', fallbackError as Error);
        }
      }
    } else {
      Logger.error(`Error in ${description}:`, error as Error);
    }

    return null;
  }
}

export async function notifyRateLimit(client: WebClient, channelOrUserId: string, context: string): Promise<void> {
  try {
    await client.chat.postMessage({
      channel: channelOrUserId,
      text: `⏳ I'm experiencing high traffic and need to slow down a bit. Your ${context} request is being processed but may take a moment longer than usual. Thank you for your patience!`,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    Logger.error('Failed to send rate limit notification:', error as Error);
  }
}
