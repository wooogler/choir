// Jest setup file
// This file runs before each test file

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.SLACK_APP_TOKEN = 'xapp-test-token';
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.DEVELOPER_USER_ID = 'U123456789';

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