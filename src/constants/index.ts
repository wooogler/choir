// Environment constants
export const NODE_ENV = {
  DEVELOPMENT: 'development',
  PRODUCTION: 'production',
} as const;

// Default repository configurations
export const DEFAULT_REPOS = {
  DEVELOPMENT: {
    owner: 'wooogler',
    repo: 'assets',
    branch: 'master',
  },
  PRODUCTION: {
    owner: 'wooogler',
    repo: 'choirlab',
    branch: 'main',
  },
} as const;

// Slack UI constants
export const SLACK_UI = {
  MAX_BLOCKS: 50,
  MAX_TEXT_LENGTH: 3000,
  MODAL_MAX_BLOCKS: 100,
} as const;

// Logging constants
export const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
} as const;

// Vector store constants
export const VECTOR_STORE = {
  CHUNK_SIZE: 1000,
  CHUNK_OVERLAP: 200,
  MAX_RESULTS: 10,
} as const;