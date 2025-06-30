import { DEFAULT_REPOS, NODE_ENV } from '@/constants';
import type { GitHubRepo } from '@/types';

export class AppConfig {
  static getDefaultRepo(): GitHubRepo {
    const isDevelopment = process.env.NODE_ENV === NODE_ENV.DEVELOPMENT;
    return isDevelopment ? DEFAULT_REPOS.DEVELOPMENT : DEFAULT_REPOS.PRODUCTION;
  }

  static getRequiredEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Required environment variable ${name} is not set`);
    }
    return value;
  }

  static getOptionalEnvVar(name: string, defaultValue?: string): string | undefined {
    return process.env[name] || defaultValue;
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