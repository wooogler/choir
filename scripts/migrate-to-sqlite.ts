import fs from 'node:fs';
import path from 'node:path';
import type { Installation } from '@slack/oauth';
import * as dotenv from 'dotenv';
import { closeDatabase } from 'services/db/connection';
import { SqliteSlackInstallationStore } from 'services/slack/sqlite-installation-store';
import { WorkspaceStore, type WorkspaceConfig } from 'services/workspace/workspace-store';

dotenv.config();

async function migrateWorkspaceConfigs(dataPath: string): Promise<number> {
  const workspaceStore = new WorkspaceStore();
  const files = fs.existsSync(dataPath) ? await fs.promises.readdir(dataPath) : [];
  const configFiles = files.filter((file) => file.endsWith('-config.json'));
  let migrated = 0;

  for (const file of configFiles) {
    const configPath = path.join(dataPath, file);
    const raw = await fs.promises.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as WorkspaceConfig;
    await workspaceStore.saveWorkspaceConfig(config);
    migrated++;
  }

  return migrated;
}

async function migrateSlackInstallations(dataPath: string): Promise<number> {
  const installPath = path.join(dataPath, 'slack-installations');
  const installationStore = new SqliteSlackInstallationStore(installPath);
  const files = fs.existsSync(installPath) ? await fs.promises.readdir(installPath) : [];
  const installationFiles = files.filter((file) => file.endsWith('.json'));
  let migrated = 0;

  for (const file of installationFiles) {
    const raw = await fs.promises.readFile(path.join(installPath, file), 'utf-8');
    const installation = JSON.parse(raw) as Installation<'v1' | 'v2', boolean>;
    await installationStore.storeInstallation(installation);
    migrated++;
  }

  return migrated;
}

async function main(): Promise<void> {
  const dataPath = path.join(process.cwd(), 'data');
  const workspaceCount = await migrateWorkspaceConfigs(dataPath);
  const installationCount = await migrateSlackInstallations(dataPath);

  console.log(`Migrated ${workspaceCount} workspace config(s) and ${installationCount} Slack installation(s) to SQLite.`);
}

main()
  .catch((error) => {
    console.error('SQLite migration failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
