import { Logger } from 'services/common/logger';

export interface RateLimitError extends Error {
  code?: string;
  // @slack/web-api's WebAPIRateLimitedError puts the delay here (seconds).
  retryAfter?: number;
  data?: {
    error?: string;
    retryAfter?: number;
  };
}

export function isRateLimitError(error: any): error is RateLimitError {
  // A 429 throws a RateLimitedError (code 'slack_webapi_rate_limited_error') with a
  // top-level retryAfter — NOT a platform_error. The old platform_error check never
  // matched, so the retry path never ran. Accept both forms to be safe.
  return (
    error?.code === 'slack_webapi_rate_limited_error' ||
    (error?.code === 'slack_webapi_platform_error' && error?.data?.error === 'rate_limited')
  );
}

export async function withRateLimit<T>(operation: () => Promise<T>, description: string, maxRetries = 3): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (isRateLimitError(error)) {
        const retryAfter = error.retryAfter ?? error.data?.retryAfter ?? 60; // Default to 60 seconds
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

  throw lastError ?? new Error(`Rate limit operation failed without an error: ${description}`);
}

export async function safeSlackCall<T>(operation: () => Promise<T>, description: string): Promise<T | null> {
  try {
    return await withRateLimit(operation, description);
  } catch (error) {
    if (isRateLimitError(error)) {
      Logger.error(`Rate limit exceeded for ${description} after retries. Operation failed.`, error as Error);
    } else {
      Logger.error(`Error in ${description}:`, error as Error);
    }

    return null;
  }
}

export function createRateLimitNotificationText(context: string): string {
  return `⏳ I'm experiencing high traffic and need to slow down a bit. Your ${context} request is being processed but may take a moment longer than usual. Thank you for your patience!`;
}
