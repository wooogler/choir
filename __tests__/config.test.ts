/**
 * Test file for current AppConfig behavior
 */

import { AppConfig } from '@/config';

describe('AppConfig', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = '';
    process.env.SLACK_MODE = '';
    process.env.SLACK_BOT_TOKEN = '';
    process.env.SLACK_APP_TOKEN = '';
    process.env.SLACK_SIGNING_SECRET = '';
    process.env.SLACK_CLIENT_ID = '';
    process.env.SLACK_CLIENT_SECRET = '';
    process.env.SLACK_STATE_SECRET = '';
    process.env.SLACK_REDIRECT_URI = '';
    process.env.SLACK_SCOPES = '';
    process.env.MANAGER_PROMOTION_PASSWORD = '';
    process.env.TEST_VAR = '';
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('getRequiredEnvVar', () => {
    it('should return environment variable value when set', () => {
      process.env.TEST_VAR = 'test_value';
      const value = AppConfig.getRequiredEnvVar('TEST_VAR');
      expect(value).toBe('test_value');
    });

    it('should throw error when required environment variable is not set', () => {
      expect(() => {
        AppConfig.getRequiredEnvVar('MISSING_VAR');
      }).toThrow('Required environment variable MISSING_VAR is not set');
    });
  });

  describe('getOptionalEnvVar', () => {
    it('should return the configured value when present', () => {
      process.env.TEST_VAR = 'configured_value';
      expect(AppConfig.getOptionalEnvVar('TEST_VAR', 'fallback')).toBe('configured_value');
    });

    it('should return the default value when the variable is missing', () => {
      expect(AppConfig.getOptionalEnvVar('MISSING_OPTIONAL', 'fallback')).toBe('fallback');
    });
  });

  describe('getSlackConfig', () => {
    beforeEach(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'signing-secret';
    });

    it('should enable socket mode outside production', () => {
      process.env.NODE_ENV = 'development';

      expect(AppConfig.getSlackConfig()).toEqual({
        mode: 'single',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'signing-secret',
        socketMode: true,
      });
    });

    it('should disable socket mode in production', () => {
      process.env.NODE_ENV = 'production';

      expect(AppConfig.getSlackConfig()).toEqual({
        mode: 'single',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'signing-secret',
        socketMode: false,
      });
    });

    it('should not require app token in single-workspace production HTTP mode', () => {
      process.env.NODE_ENV = 'production';
      process.env.SLACK_APP_TOKEN = '';

      expect(AppConfig.getSlackConfig()).toEqual({
        mode: 'single',
        botToken: 'xoxb-test',
        appToken: undefined,
        signingSecret: 'signing-secret',
        socketMode: false,
      });
    });

    it('should return OAuth config when Slack mode is oauth', () => {
      process.env.SLACK_MODE = 'oauth';
      process.env.SLACK_CLIENT_ID = 'client-id';
      process.env.SLACK_CLIENT_SECRET = 'client-secret';
      process.env.SLACK_STATE_SECRET = 'state-secret';
      process.env.SLACK_REDIRECT_URI = 'https://example.com/slack/oauth_redirect';
      process.env.SLACK_SCOPES = 'chat:write, users:read ';

      expect(AppConfig.getSlackConfig()).toEqual({
        mode: 'oauth',
        signingSecret: 'signing-secret',
        socketMode: false,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        stateSecret: 'state-secret',
        redirectUri: 'https://example.com/slack/oauth_redirect',
        scopes: ['chat:write', 'users:read'],
      });
    });
  });

  describe('getManagerPromotionConfig', () => {
    it('should return the optional manager promotion password', () => {
      process.env.MANAGER_PROMOTION_PASSWORD = 'top-secret';

      expect(AppConfig.getManagerPromotionConfig()).toEqual({
        password: 'top-secret',
      });
    });
  });
});
