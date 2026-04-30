import fs from 'node:fs';
import path from 'node:path';
import type { Installation, InstallationQuery, InstallationStore } from '@slack/oauth';
import { getDataPath } from 'services/common/data-path';
import { decryptJson, encryptJson } from 'services/db/crypto';
import { getDatabase } from 'services/db/connection';
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

export class SqliteSlackInstallationStore implements InstallationStore {
  constructor(private readonly legacyRootPath = getDataPath('slack-installations')) {}

  private getLegacyInstallationPath(id: string): string {
    return path.join(this.legacyRootPath, `${safeFileName(id)}.json`);
  }

  async storeInstallation<AuthVersion extends 'v1' | 'v2'>(
    installation: Installation<AuthVersion, boolean>,
  ): Promise<void> {
    const typedInstallation = installation as Installation<'v1' | 'v2', boolean>;
    const id = getInstallationIdFromInstallation(typedInstallation);
    const db = getDatabase();

    db.prepare(`
      INSERT INTO slack_installations (
        installation_id,
        team_id,
        enterprise_id,
        installation_json,
        created_at,
        updated_at
      )
      VALUES (@installationId, @teamId, @enterpriseId, @installationJson, datetime('now'), datetime('now'))
      ON CONFLICT(installation_id) DO UPDATE SET
        team_id = excluded.team_id,
        enterprise_id = excluded.enterprise_id,
        installation_json = excluded.installation_json,
        updated_at = datetime('now')
    `).run({
      installationId: id,
      teamId: typedInstallation.team?.id || null,
      enterpriseId: typedInstallation.enterprise?.id || null,
      installationJson: encryptJson(typedInstallation),
    });

    Logger.info('Stored Slack installation in SQLite.', {
      installationId: id,
      teamId: typedInstallation.team?.id,
      enterpriseId: typedInstallation.enterprise?.id,
    });
  }

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation<'v1' | 'v2', boolean>> {
    const id = getInstallationId(query);
    const db = getDatabase();
    const row = db
      .prepare('SELECT installation_json AS installationJson FROM slack_installations WHERE installation_id = ?')
      .get(id) as { installationJson: string } | undefined;

    if (row) {
      return decryptJson<Installation<'v1' | 'v2', boolean>>(row.installationJson);
    }

    const legacyInstallation = await this.fetchLegacyInstallation(id);
    if (legacyInstallation) {
      await this.storeInstallation(legacyInstallation);
      Logger.info('Migrated legacy Slack installation into SQLite.', {
        installationId: id,
        teamId: query.teamId,
        enterpriseId: query.enterpriseId,
      });
      return legacyInstallation;
    }

    Logger.warn('Slack installation not found in SQLite.', {
      installationId: id,
      teamId: query.teamId,
      enterpriseId: query.enterpriseId,
    });
    throw new Error(`Slack installation not found: ${id}`);
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const id = getInstallationId(query);
    getDatabase().prepare('DELETE FROM slack_installations WHERE installation_id = ?').run(id);
    await fs.promises.rm(this.getLegacyInstallationPath(id), { force: true });
    Logger.info('Deleted Slack installation from SQLite.', {
      installationId: id,
      teamId: query.teamId,
      enterpriseId: query.enterpriseId,
    });
  }

  async deleteWorkspaceInstallation(workspaceId: string): Promise<void> {
    await this.deleteInstallation({
      teamId: workspaceId,
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    });
  }

  private async fetchLegacyInstallation(id: string): Promise<Installation<'v1' | 'v2', boolean> | null> {
    const targetPath = this.getLegacyInstallationPath(id);
    if (!fs.existsSync(targetPath)) {
      return null;
    }

    const raw = await fs.promises.readFile(targetPath, 'utf-8');
    return JSON.parse(raw) as Installation<'v1' | 'v2', boolean>;
  }
}
