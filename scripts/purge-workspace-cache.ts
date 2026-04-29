import * as dotenv from 'dotenv';
import { closeDatabase } from 'services/db/connection';
import { WorkspaceCleanupService } from 'services/workspace/workspace-cleanup-service';

dotenv.config();

async function main(): Promise<void> {
  const workspaceId = process.argv[2];

  if (!workspaceId) {
    console.error('Usage: pnpm purge:workspace-cache <workspaceId>');
    process.exitCode = 1;
    return;
  }

  await WorkspaceCleanupService.getInstance().purgeWorkspaceCache(workspaceId);
  console.log(`Purged workspace cache for ${workspaceId}.`);
}

main()
  .catch((error) => {
    console.error('Failed to purge workspace cache:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
