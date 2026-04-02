/**
 * Test file for current AppConfig behavior
 */

import { AppConfig } from '@/config';

describe('AppConfig', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = undefined;
    process.env.SLACK_BOT_TOKEN = undefined;
    process.env.SLACK_APP_TOKEN = undefined;
    process.env.SLACK_SIGNING_SECRET = undefined;
    process.env.MANAGER_PROMOTION_PASSWORD = undefined;
    process.env.TEST_VAR = undefined;
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
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'signing-secret',
        socketMode: true,
      });
    });

    it('should disable socket mode in production', () => {
      process.env.NODE_ENV = 'production';

      expect(AppConfig.getSlackConfig()).toEqual({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'signing-secret',
        socketMode: false,
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
