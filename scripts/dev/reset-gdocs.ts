/**
 * Puts the fake Google Docs world back to nothing, so the loop can start over.
 *
 * Usage:
 *   pnpm gdocs:reset [--workspace <id>]
 *
 * Unlinks every document, drops the sync state and baselines, and empties the
 * fake Drive. Refuses to touch a credential that is not the seed script's fake
 * one, so pointing this at a workspace with a real Google account connected
 * leaves that account alone.
 *
 * It does not restore the workspace mirror: an approved edit is a real write to
 * data/dev/workspaces/<id>/repo. Use "Reload from GitHub" in App Home for that.
 */
import fs from 'node:fs';
import * as dotenv from 'dotenv';
import { getDataPath } from 'services/common/data-path';
import { closeDatabase } from 'services/db/connection';
import { removeBaseline, removeDocState } from 'services/google/gdocs-state';
import { WorkspaceStore } from 'services/workspace/workspace-store';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

const FAKE_REFRESH_TOKEN = 'fake-refresh-token';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const store = new WorkspaceStore();
  const configs = await store.getAllWorkspaceConfigs();
  const requested = readArg('workspace');
  const targets = requested ? configs.filter((config) => config.workspaceId === requested) : configs;

  if (targets.length === 0) {
    throw new Error(requested ? `No such workspace: ${requested}` : 'No workspaces in this database.');
  }

  for (const config of targets) {
    const workspaceId = config.workspaceId;
    const mappings = await store.getGoogleDocMappings(workspaceId);

    for (const githubPath of Object.keys(mappings)) {
      await store.removeGoogleDocMapping(workspaceId, githubPath);
      await removeDocState(workspaceId, githubPath);
      await removeBaseline(workspaceId, githubPath);
      console.log(`• unlinked ${workspaceId} / ${githubPath}`);
    }

    const auth = await store.getGoogleAuth(workspaceId);
    if (auth && auth.refreshToken === FAKE_REFRESH_TOKEN) {
      await store.clearGoogleAuth(workspaceId);
      console.log(`• removed the fake Google credential from ${workspaceId}`);
    } else if (auth) {
      console.log(`• left ${workspaceId}'s real Google credential alone`);
    }
  }

  const storePath = getDataPath('fake-drive.json');
  if (fs.existsSync(storePath)) {
    fs.rmSync(storePath);
    console.log('• emptied the fake Drive');
  }
}

main()
  .catch((error) => {
    console.error(`reset-gdocs failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
