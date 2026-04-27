import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { withRateLimit } from './rate-limit-handler';
import { getWorkspaceId, setupInitialManager } from './user-management';

export interface WorkspaceBootstrapResult {
  workspaceId: string;
  workspaceOwner?: string;
  initialized: boolean;
}

const workspaceStore = new WorkspaceStore();

export async function ensureWorkspaceInitialized(
  client: WebClient,
  fallbackManagerId?: string,
): Promise<WorkspaceBootstrapResult> {
  const workspaceId = await getWorkspaceId(client);
  const existingConfig = await workspaceStore.getWorkspaceConfig(workspaceId);

  if (existingConfig) {
    return {
      workspaceId,
      workspaceOwner: existingConfig.managers[0],
      initialized: false,
    };
  }

  let workspaceOwner: string | undefined;
  try {
    const usersList = await withRateLimit(() => client.users.list({}), 'get users list for workspace owner');
    const owner = usersList.members?.find((user) => user.is_owner === true);
    workspaceOwner = owner?.id;
  } catch (error) {
    Logger.warn('Failed to look up workspace owner during bootstrap.', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const initialManagerId = workspaceOwner || fallbackManagerId;
  if (!initialManagerId) {
    Logger.warn('Workspace bootstrap skipped because no initial manager could be determined.', {
      workspaceId,
    });
    return {
      workspaceId,
      initialized: false,
    };
  }

  await setupInitialManager(workspaceId, initialManagerId, client);
  Logger.info('Workspace initialized during bootstrap.', {
    workspaceId,
    initialManagerId,
    workspaceOwner,
  });

  return {
    workspaceId,
    workspaceOwner: initialManagerId,
    initialized: true,
  };
}
