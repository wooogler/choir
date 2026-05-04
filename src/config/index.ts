import { NODE_ENV } from '@/constants';
import { CHOIRError, ErrorCodes } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';

export type SlackMode = 'single' | 'oauth';

const DEFAULT_SLACK_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:join',
  'channels:read',
  'chat:write',
  'groups:history',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'mpim:write',
  'team:read',
  'users:read',
  'files:write',
];

// biome-ignore lint/complexity/noStaticOnlyClass: Existing code imports AppConfig as a static configuration facade.
export class AppConfig {
  static getRequiredEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) {
      const error = new CHOIRError(`Required environment variable ${name} is not set`, ErrorCodes.CONFIGURATION_ERROR, {
        envVar: name,
      });
      Logger.error('Configuration error: Missing required environment variable', error);
      throw error;
    }
    return value;
  }

  static getOptionalEnvVar(name: string, defaultValue?: string): string | undefined {
    const value = process.env[name] || defaultValue;
    if (!value && defaultValue) {
      Logger.debug(`Using default value for environment variable ${name}`, { defaultValue });
    }
    return value;
  }

  static getSlackMode(): SlackMode {
    return process.env.SLACK_MODE === 'oauth' ? 'oauth' : 'single';
  }

  static getSlackScopes(): string[] {
    const configuredScopes = AppConfig.getOptionalEnvVar('SLACK_SCOPES');
    if (!configuredScopes) {
      return DEFAULT_SLACK_SCOPES;
    }

    return configuredScopes
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
  }

  static getSlackConfig() {
    const mode = AppConfig.getSlackMode();
    const signingSecret = AppConfig.getRequiredEnvVar('SLACK_SIGNING_SECRET');

    if (mode === 'oauth') {
      return {
        mode,
        signingSecret,
        socketMode: false,
        clientId: AppConfig.getRequiredEnvVar('SLACK_CLIENT_ID'),
        clientSecret: AppConfig.getRequiredEnvVar('SLACK_CLIENT_SECRET'),
        stateSecret: AppConfig.getRequiredEnvVar('SLACK_STATE_SECRET'),
        redirectUri: AppConfig.getOptionalEnvVar('SLACK_REDIRECT_URI'),
        scopes: AppConfig.getSlackScopes(),
      };
    }

    const socketMode = process.env.NODE_ENV !== NODE_ENV.PRODUCTION;

    return {
      mode,
      botToken: AppConfig.getRequiredEnvVar('SLACK_BOT_TOKEN'),
      appToken: socketMode
        ? AppConfig.getRequiredEnvVar('SLACK_APP_TOKEN')
        : AppConfig.getOptionalEnvVar('SLACK_APP_TOKEN'),
      signingSecret,
      socketMode,
    };
  }

  static getManagerPromotionConfig() {
    return {
      password: AppConfig.getOptionalEnvVar('MANAGER_PROMOTION_PASSWORD'),
    };
  }
}
