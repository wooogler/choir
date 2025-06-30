/**
 * Test file for configuration
 * Run with: pnpm test:unit
 */

import { AppConfig } from '@/config';

describe('AppConfig', () => {
  beforeEach(() => {
    // Reset environment variables
    delete process.env.NODE_ENV;
    delete process.env.SLACK_BOT_TOKEN;
  });

  describe('getDefaultRepo', () => {
    it('should return development repo for development environment', () => {
      process.env.NODE_ENV = 'development';
      const repo = AppConfig.getDefaultRepo();
      expect(repo.owner).toBe('wooogler');
      expect(repo.repo).toBe('assets');
      expect(repo.branch).toBe('master');
    });

    it('should return production repo for production environment', () => {
      process.env.NODE_ENV = 'production';
      const repo = AppConfig.getDefaultRepo();
      expect(repo.owner).toBe('wooogler');
      expect(repo.repo).toBe('choirlab');
      expect(repo.branch).toBe('main');
    });
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
});