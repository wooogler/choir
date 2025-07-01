import { DEFAULT_REPOS, NODE_ENV } from '@/constants';
import type { GitHubRepo } from '@/types';
import { Logger } from 'services/common/logger';
import { CHOIRError, ErrorCodes } from 'services/common/error-handler';

export class AppConfig {
  static getDefaultRepo(): GitHubRepo {
    const isDevelopment = process.env.NODE_ENV === NODE_ENV.DEVELOPMENT;
    const repo = isDevelopment ? DEFAULT_REPOS.DEVELOPMENT : DEFAULT_REPOS.PRODUCTION;
    Logger.debug('Using default repository', { repo, isDevelopment });
    return repo;
  }

  static getRequiredEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) {
      const error = new CHOIRError(
        `Required environment variable ${name} is not set`,
        ErrorCodes.CONFIGURATION_ERROR,
        { envVar: name }
      );
      Logger.error(`Configuration error: Missing required environment variable`, error);
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

  static getSlackConfig() {
    return {
      botToken: this.getRequiredEnvVar('SLACK_BOT_TOKEN'),
      appToken: this.getRequiredEnvVar('SLACK_APP_TOKEN'),
      signingSecret: this.getRequiredEnvVar('SLACK_SIGNING_SECRET'),
      socketMode: process.env.NODE_ENV !== NODE_ENV.PRODUCTION,
    };
  }

  static getAzureOpenAIConfig() {
    return {
      apiKey: this.getOptionalEnvVar('AZURE_OPENAI_API_KEY'),
      endpoint: this.getOptionalEnvVar('AZURE_OPENAI_ENDPOINT'),
      deploymentName: this.getOptionalEnvVar('AZURE_OPENAI_DEPLOYMENT_NAME'),
      embeddingsDeploymentName: this.getOptionalEnvVar('AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME'),
    };
  }

  static getGitHubConfig() {
    return {
      token: this.getOptionalEnvVar('GITHUB_TOKEN'),
    };
  }

  static getDeveloperConfig() {
    return {
      userId: this.getOptionalEnvVar('DEVELOPER_USER_ID'),
    };
  }
}