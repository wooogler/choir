/**
 * Seeds a linked Google Doc replica in the fake Drive, so the review flow has
 * something to review.
 *
 * Usage:
 *   pnpm gdocs:seed [--workspace <id>] [--path <repo/path.md>]
 *
 * Leaves the document in `synced`: a replica exists, a baseline and a source
 * snapshot are recorded, and nothing has drifted yet. Run `pnpm gdocs:edit` next
 * to play the part of a person typing in Docs.
 *
 * Safe to re-run: it re-links the same repo path to a fresh fake Doc and
 * republishes. Requires the fake Drive — it never talks to Google.
 */
import * as dotenv from 'dotenv';
import { closeDatabase } from 'services/db/connection';
import { publishReplica } from 'services/google/replica-publisher';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { tagDoc } from './fake-drive';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

const DEFAULT_PATH = 'README.md';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveWorkspaceId(store: WorkspaceStore, requested?: string): Promise<string> {
  const configs = await store.getAllWorkspaceConfigs();
  if (requested) {
    const match = configs.find((config) => config.workspaceId === requested);
    if (!match) throw new Error(`No such workspace: ${requested}`);
    return match.workspaceId;
  }
  if (configs.length === 0) {
    throw new Error('No workspaces in this database. Start the app once and open App Home first.');
  }
  if (configs.length > 1) {
    throw new Error(`Several workspaces here; pass --workspace: ${configs.map((c) => c.workspaceId).join(', ')}`);
  }
  return configs[0].workspaceId;
}

async function main(): Promise<void> {
  const store = new WorkspaceStore();
  const workspaceId = await resolveWorkspaceId(store, readArg('workspace'));
  const githubPath = readArg('path') || DEFAULT_PATH;

  const config = await store.getWorkspaceConfig(workspaceId);
  const managerId = config?.managers?.[0];
  if (!managerId) {
    throw new Error(`Workspace ${workspaceId} has no managers; promote one in App Home first.`);
  }

  const markdown = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, githubPath);
  if (markdown === null) {
    throw new Error(`${githubPath} is not in the workspace mirror. Reload from GitHub in App Home first.`);
  }

  // The Drive client is faked, so this credential is never presented to anyone —
  // it exists because every replica trigger checks that an account is connected.
  if (!(await store.getGoogleAuth(workspaceId))) {
    await store.setGoogleAuth(workspaceId, {
      refreshToken: 'fake-refresh-token',
      email: 'choir-dev-workspace@example.com',
      connectedBy: managerId,
    });
    console.log('• connected a fake Google account');
  }

  const { createDocFromMarkdown } = require('services/google/drive-client') as {
    createDocFromMarkdown: (
      auth: unknown,
      params: { name: string; markdown: string },
    ) => Promise<{ fileId: string; webViewLink?: string }>;
  };
  const created = await createDocFromMarkdown(null, { name: githubPath, markdown: '' });
  tagDoc(created.fileId, workspaceId, githubPath);
  await store.setGoogleDocMapping(workspaceId, githubPath, {
    fileId: created.fileId,
    webViewLink: created.webViewLink ?? `http://localhost/fake-drive/${created.fileId}`,
    linkedBy: managerId,
  });
  console.log(`• linked ${githubPath} → ${created.fileId}`);

  // force: the document was just created, so there is no prior hash to compare
  // and nothing to hold back. This is the call that writes the baseline and the
  // source snapshot the review is later measured against.
  const published = await publishReplica({ workspaceId, githubPath, markdown, force: true });
  console.log(`• publishReplica → ${published.outcome}${published.detail ? ` (${published.detail})` : ''}`);

  if (published.outcome !== 'published') {
    throw new Error(`Seeding stopped: the replica was not published (${published.outcome})`);
  }

  console.log('');
  console.log(`Seeded ${workspaceId} / ${githubPath}. Next:`);
  console.log(`  pnpm gdocs:edit --path ${githubPath}`);
}

main()
  .catch((error) => {
    console.error(`seed-gdocs failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
