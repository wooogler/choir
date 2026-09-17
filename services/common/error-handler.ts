/**
 * Values that may be interpolated into the reader's translation of an error.
 * Deliberately narrower than `metadata`, which is for the log line: these end
 * up inside a sentence a person reads, so they have to render as text.
 */
export type ErrorParams = Record<string, string | number>;

export class CHOIRError extends Error {
  constructor(
    message: string,
    public code: string,
    public metadata?: any,
    public statusCode?: number,
    /**
     * Fillers for the catalog entry `errors.<code>`, when `code` names one.
     * `message` stays English for the log; `params` is what makes the reader's
     * language possible without re-parsing that English.
     */
    public params?: ErrorParams,
  ) {
    super(message);
    this.name = 'CHOIRError';
  }
}

export class VectorStoreError extends CHOIRError {
  constructor(message: string, options: { code: string; metadata?: any }) {
    super(message, options.code, options.metadata, 500);
    this.name = 'VectorStoreError';
  }
}

export class GitHubError extends CHOIRError {
  constructor(message: string, options: { code: string; metadata?: any; statusCode?: number; params?: ErrorParams }) {
    super(message, options.code, options.metadata, options.statusCode || 500, options.params);
    this.name = 'GitHubError';
  }
}

export class SlackError extends CHOIRError {
  constructor(message: string, options: { code: string; metadata?: any }) {
    super(message, options.code, options.metadata, 500);
    this.name = 'SlackError';
  }
}

export const ErrorCodes = {
  // Vector Store Errors
  VECTOR_STORE_NOT_INITIALIZED: 'VECTOR_STORE_NOT_INITIALIZED',
  VECTOR_STORE_INITIALIZATION_FAILED: 'VECTOR_STORE_INITIALIZATION_FAILED',
  VECTOR_STORE_NO_RESULTS: 'VECTOR_STORE_NO_RESULTS',

  // GitHub Errors
  GITHUB_CONNECTION_FAILED: 'GITHUB_CONNECTION_FAILED',
  GITHUB_FILE_NOT_FOUND: 'GITHUB_FILE_NOT_FOUND',
  GITHUB_FILE_EXISTS: 'GITHUB_FILE_EXISTS',
  GITHUB_UPDATE_FAILED: 'GITHUB_UPDATE_FAILED',
  GITHUB_INVALID_URL: 'GITHUB_INVALID_URL',
  // Write failures worth distinguishing: GitHub answers a missing write
  // permission with 404, so callers need the reason, not just "update failed".
  GITHUB_WRITE_FORBIDDEN: 'GITHUB_WRITE_FORBIDDEN',
  GITHUB_AUTH_FAILED: 'GITHUB_AUTH_FAILED',
  GITHUB_CONFLICT: 'GITHUB_CONFLICT',
  GITHUB_RATE_LIMITED: 'GITHUB_RATE_LIMITED',
  GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',

  // Slack Errors
  SLACK_MESSAGE_FAILED: 'SLACK_MESSAGE_FAILED',
  SLACK_USER_NOT_FOUND: 'SLACK_USER_NOT_FOUND',
  SLACK_CHANNEL_NOT_FOUND: 'SLACK_CHANNEL_NOT_FOUND',

  // General Errors
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
} as const;
