import fs from 'node:fs';
import path from 'node:path';
import type { Installation, InstallationQuery, InstallationStore } from '@slack/oauth';
import { Logger } from 'services/common/logger';

function getInstallationId(query: InstallationQuery<boolean>): string {
  if (query.isEnterpriseInstall && query.enterpriseId) {
    return `enterprise-${query.enterpriseId}`;
  }

  if (query.teamId) {
    return `team-${query.teamId}`;
  }

  throw new Error('Slack installation query did not include a teamId or enterpriseId.');
}

function getInstallationIdFromInstallation(installation: Installation<'v1' | 'v2', boolean>): string {
  if (installation.isEnterpriseInstall && installation.enterprise?.id) {
    return `enterprise-${installation.enterprise.id}`;
  }

  if (installation.team?.id) {
    return `team-${installation.team.id}`;
  }

  throw new Error('Slack installation did not include a team id or enterprise id.');
}

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class FileSlackInstallationStore implements InstallationStore {
  private readonly rootPath: string;

  constructor(rootPath = path.join(process.cwd(), 'data', 'slack-installations')) {
    this.rootPath = rootPath;
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.rootPath, { recursive: true });
  }

  private getInstallationPath(id: string): string {
    return path.join(this.rootPath, `${safeFileName(id)}.json`);
  }

  async storeInstallation<AuthVersion extends 'v1' | 'v2'>(
    installation: Installation<AuthVersion, boolean>,
  ): Promise<void> {
    this.ensureRoot();
    const id = getInstallationIdFromInstallation(installation as Installation<'v1' | 'v2', boolean>);
    const targetPath = this.getInstallationPath(id);

    await fs.promises.writeFile(targetPath, JSON.stringify(installation, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });

    Logger.info('Stored Slack installation.', {
      installationId: id,
      teamId: installation.team?.id,
      enterpriseId: installation.enterprise?.id,
    });
  }

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation<'v1' | 'v2', boolean>> {
    const id = getInstallationId(query);
    const targetPath = this.getInstallationPath(id);

    try {
      const raw = await fs.promises.readFile(targetPath, 'utf-8');
      return JSON.parse(raw) as Installation<'v1' | 'v2', boolean>;
    } catch (error) {
      Logger.warn('Slack installation not found.', {
        installationId: id,
        teamId: query.teamId,
        enterpriseId: query.enterpriseId,
      });
      throw error;
    }
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const id = getInstallationId(query);
    const targetPath = this.getInstallationPath(id);
    await fs.promises.rm(targetPath, { force: true });
    Logger.info('Deleted Slack installation.', {
      installationId: id,
      teamId: query.teamId,
      enterpriseId: query.enterpriseId,
    });
  }
}
