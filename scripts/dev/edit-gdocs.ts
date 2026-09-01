/**
 * Plays the part of a person editing the Google Doc replica: appends text to
 * the fake Doc and bumps its version, which is the only signal the drift poller
 * has to go on.
 *
 * Usage:
 *   pnpm gdocs:edit [--workspace <id>] [--path <repo/path.md>] [--text "..."]
 *                   [--as someone@example.com]
 *
 * The running app picks it up on the next sweep — set GOOGLE_DRIFT_POLL_MS low
 * (`pnpm dev:local --fake-google` sets 5000) so that is seconds, not minutes.
 * There is deliberately no "detect it now" flag: the lock the sweep takes is
 * per-process, so a second process forcing a check would race the app.
 */
import * as dotenv from 'dotenv';
import { closeDatabase } from 'services/db/connection';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { findDocByPath, mutateDoc } from './fake-drive';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

const DEFAULT_PATH = 'README.md';
const DEFAULT_EDITOR = 'a.person@example.com';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveWorkspaceId(requested?: string): Promise<string> {
  const configs = await new WorkspaceStore().getAllWorkspaceConfigs();
  if (requested) {
    const match = configs.find((config) => config.workspaceId === requested);
    if (!match) throw new Error(`No such workspace: ${requested}`);
    return match.workspaceId;
  }
  if (configs.length === 0) {
    throw new Error('No workspaces in this database.');
  }
  if (configs.length > 1) {
    throw new Error(`Several workspaces here; pass --workspace: ${configs.map((c) => c.workspaceId).join(', ')}`);
  }
  return configs[0].workspaceId;
}

async function main(): Promise<void> {
  const workspaceId = await resolveWorkspaceId(readArg('workspace'));
  const githubPath = readArg('path') || DEFAULT_PATH;
  const editor = readArg('as') || DEFAULT_EDITOR;
  const text = readArg('text') || `A paragraph typed in Docs at ${new Date().toISOString()}.`;

  const doc = findDocByPath(workspaceId, githubPath);
  if (!doc) {
    throw new Error(`No fake Doc for ${githubPath}. Run: pnpm gdocs:seed --path ${githubPath}`);
  }

  const updated = mutateDoc(doc.fileId, (current) => {
    current.markdown = `${current.markdown.replace(/\s*$/, '')}\n\n${text}\n`;
    current.version += 1;
    current.modifiedTime = new Date().toISOString();
    current.lastModifyingUser = editor;
  });

  console.log(`• ${githubPath} edited by ${editor} — version ${updated.version}`);
  console.log(`  "${text}"`);
  console.log('');
  console.log('The next drift sweep will move it to `drifted` and DM the managers a review card.');
}

main()
  .catch((error) => {
    console.error(`edit-gdocs failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
