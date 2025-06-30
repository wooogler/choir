export class CHOIRError extends Error {
  constructor(
    message: string,
    public code: string,
    public metadata?: any,
    public statusCode?: number,
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
  constructor(message: string, options: { code: string; metadata?: any; statusCode?: number }) {
    super(message, options.code, options.metadata, options.statusCode || 500);
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
  GITHUB_UPDATE_FAILED: 'GITHUB_UPDATE_FAILED',
  GITHUB_INVALID_URL: 'GITHUB_INVALID_URL',

  // Slack Errors
  SLACK_MESSAGE_FAILED: 'SLACK_MESSAGE_FAILED',
  SLACK_USER_NOT_FOUND: 'SLACK_USER_NOT_FOUND',
  SLACK_CHANNEL_NOT_FOUND: 'SLACK_CHANNEL_NOT_FOUND',

  // General Errors
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
} as const;
