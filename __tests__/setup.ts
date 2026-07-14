// Jest setup file
// This file runs before each test file

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.SLACK_APP_TOKEN = 'xapp-test-token';
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.MANAGER_PROMOTION_PASSWORD = 'test-password';
// Pin the docs-editor signing key so signed-payload/image-token don't derive it
// from a key file under CHOIR_DATA_DIR. Tests that point CHOIR_DATA_DIR at a temp
// dir (and delete it) would otherwise make the lazily-cached key non-deterministic
// across files sharing a jest worker, flaking the image-token suite.
process.env.CHOIR_DOCS_EDITOR_SIGNING_KEY = 'a'.repeat(64);

// Extend Jest matchers if needed
// import '@testing-library/jest-dom';

// Global test utilities
global.console = {
  ...console,
  // Uncomment to silence console during tests
  // log: jest.fn(),
  // warn: jest.fn(),
  // error: jest.fn(),
};

// This is not a test file - just setup
export {};
